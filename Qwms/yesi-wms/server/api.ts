import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Redis from "ioredis";
import { z } from "zod";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { config, permissions, type Actor, type Role } from "./config.js";
import {
  pool,
  tx,
  uid,
  hash,
  token,
  encrypt,
  decrypt,
  one,
  fail,
  audit,
  emit,
  DomainError,
  verifyAudit,
} from "./db.js";
import { authenticate, registerAuth, verifyCsrf, SESSION } from "./auth.js";
import * as domain from "./domain.js";
import { credentialsSchema, marketplaceDocs } from "./connectors.js";
import { metrics, registry } from "./metrics.js";
import { attachRealtime } from "./realtime.js";
declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
    rawBody?: Buffer;
  }
}
const routeDocs: {
  method: string;
  url: string;
  schema?: unknown;
  mutation?: boolean;
}[] = [];
export async function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 1048576, trustProxy: false });
  app.decorate("routesToJson", () => routeDocs);
  app.addHook("onRoute", (r) => {
    if (
      ["GET", "POST"].includes(r.method as string) &&
      r.url.startsWith("/api/")
    )
      routeDocs.push({ method: r.method as string, url: r.url });
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'", config.origin],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    strictTransportSecurity: !config.development,
  });
  const redis = config.redisUrl ? new Redis(config.redisUrl) : undefined;
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    redis,
    allowList: (req) => req.url === "/health" || req.url === "/metrics",
  });
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      req.rawBody = body as Buffer;
      try {
        done(null, JSON.parse(body.toString("utf8")));
      } catch {
        done(new Error("Invalid JSON"), undefined);
      }
    },
  );
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-ID", String(req.id));
    reply.header("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin) {
      const u = new URL(origin);
      const local =
        config.development && ["localhost", "127.0.0.1"].includes(u.hostname);
      const preview =
        config.development &&
        u.protocol === "https:" &&
        /^5173-[a-z0-9-]+\.e2b\.app$/.test(u.hostname);
      if (origin !== config.origin && !local && !preview)
        fail(403, "ORIGIN_REJECTED", "Origin not allowed");
    }
  });
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url || "unmatched";
    metrics.requests.inc({
      method: req.method,
      route,
      status: String(reply.statusCode),
    });
    metrics.duration.observe(
      { method: req.method, route },
      reply.elapsedTime / 1000,
    );
    console.log(
      JSON.stringify({
        level: "info",
        request_id: req.id,
        method: req.method,
        route,
        status: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime),
        actor_id: req.actor?.id,
      }),
    );
  });
  app.setErrorHandler((e, req, reply) => {
    const err = e as Error;
    const known = e instanceof DomainError;
    const validation = e instanceof z.ZodError;
    const status = known
      ? e.status
      : validation
        ? 400
        : (e as any).statusCode || 500;
    const code = known
      ? e.code
      : validation
        ? "VALIDATION_ERROR"
        : status === 429
          ? "RATE_LIMITED"
          : "INTERNAL_ERROR";
    if (status >= 500)
      console.error(
        JSON.stringify({
          level: "error",
          request_id: req.id,
          code,
          message: err.message,
        }),
      );
    reply
      .status(status)
      .send({
        error: {
          code,
          message: validation
            ? (e as z.ZodError).issues.map((i) => ({
                path: i.path,
                message: i.message,
              }))
            : known || status < 500
              ? err.message
              : "Request failed; contact support with request ID",
          request_id: req.id,
        },
      });
  });
  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return {
      status: "ok",
      database: "ok",
      mode: config.development ? "development" : "production",
      connectors: "sandbox",
    };
  });
  app.get("/metrics", async (req, reply) => {
    if (
      config.metricsToken &&
      req.headers.authorization !== "Bearer " + config.metricsToken
    )
      fail(401, "UNAUTHENTICATED", "Metrics token required");
    const rows = (
      await pool.query(
        "SELECT status,count(*)::int AS n FROM outbox GROUP BY status",
      )
    ).rows;
    for (const s of ["PENDING", "PROCESSING", "DONE", "DEAD"])
      metrics.backlog.set(
        { status: s },
        rows.find((r: any) => r.status === s)?.n || 0,
      );
    reply.type(registry.contentType);
    return registry.metrics();
  });
  registerAuth(app);
  const auth = (permission: string) => async (req: FastifyRequest) => {
    req.actor = await authenticate(req);
    if (!permissions[permission]?.includes(req.actor.role))
      fail(403, "FORBIDDEN", "Your role cannot perform this action");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) await verifyCsrf(req);
  };
  const read = auth("read");
  const keySchema = z.string().min(8).max(128);
  function mutation(
    path: string,
    permission: string,
    schema: z.ZodType,
    fn: (b: any, a: Actor, id: string) => Promise<unknown>,
  ) {
    routeDocs.push({
      method: "POST",
      url: path,
      schema: z.toJSONSchema(schema),
      mutation: true,
    });
    app.post(path, { preHandler: auth(permission) }, async (req) => {
      const a = req.actor!;
      const key = keySchema.parse(req.headers["idempotency-key"]);
      const b = schema.parse(req.body);
      const id = (req.params as any).id;
      return tx((c) =>
        domain.command(
          c,
          a.id + ":" + req.method + ":" + path.replace(id || "$", ":id"),
          key,
          { body: b, id },
          () => fn(b, a, id),
        ),
      );
    });
  }
  app.get("/api/v1/auth/me", { preHandler: read }, async (req) => {
    const t = req.cookies[SESSION];
    const s = await one(
      pool,
      "SELECT csrf,expires_at FROM sessions WHERE token_hash=$1",
      [hash(t!)],
    );
    return { ...req.actor, csrf: s.csrf, expires_at: s.expires_at };
  });
  app.post("/api/v1/auth/ticket", { preHandler: read }, async (req) => {
    const t = token();
    await pool.query(
      "INSERT INTO ws_tickets VALUES($1,$2,now()+interval '30 seconds')",
      [hash(t), req.actor!.id],
    );
    return { ticket: t, expires_in: 30 };
  });
  app.get("/api/v1/control-tower/kpis", { preHandler: read }, async () => {
    const r = await pool.query(
      "SELECT (SELECT count(*) FROM orders WHERE status NOT IN ('SHIPPED','DELIVERED','CANCELLED'))::int AS open_orders,(SELECT count(*) FROM orders WHERE status IN ('SHIPPED','DELIVERED') AND updated_at::date=current_date)::int AS shipped_today,(SELECT count(*) FROM exceptions WHERE status='OPEN')::int AS exceptions,(SELECT coalesce(sum(on_hand-reserved),0) FROM inventory)::int AS available,(SELECT count(*) FROM outbox WHERE status='DEAD')::int AS dead_events,(SELECT count(*) FROM orders WHERE ship_by<now() AND status NOT IN ('SHIPPED','DELIVERED','CANCELLED'))::int AS overdue,(SELECT coalesce(max(seq),0) FROM outbox)::int AS sequence",
    );
    return r.rows[0];
  });
  app.get("/api/v1/snapshot", { preHandler: read }, async (req) => {
    const cursor = (
      await pool.query("SELECT coalesce(max(seq),0)::int AS seq FROM outbox")
    ).rows[0].seq;
    const orders = (
      await pool.query(
        "SELECT o.*,c.provider,c.mode,(SELECT coalesce(sum(quantity),0) FROM order_lines WHERE order_id=o.id)::int AS units FROM orders o JOIN connections c ON c.id=o.connection_id ORDER BY o.created_at DESC LIMIT 1000",
      )
    ).rows;
    const inventory = (
      await pool.query(
        "SELECT i.*,p.name,p.cost_minor FROM inventory i JOIN products p ON p.sku=i.sku ORDER BY i.sku,i.location",
      )
    ).rows;
    const connections = (
      await pool.query(
        "SELECT id,provider,account_id,mode,enabled,last_sync_at FROM connections ORDER BY provider",
      )
    ).rows;
    const waves = (
      await pool.query(
        "SELECT w.*,coalesce(json_agg(o.id) FILTER (WHERE o.id IS NOT NULL),'[]') AS order_ids FROM waves w LEFT JOIN wave_orders wo ON wo.wave_id=w.id LEFT JOIN orders o ON o.id=wo.order_id GROUP BY w.id ORDER BY w.created_at DESC",
      )
    ).rows;
    const shipments = (
      await pool.query(
        "SELECT s.*,o.external_id AS order_reference FROM shipments s JOIN orders o ON o.id=s.order_id ORDER BY s.created_at DESC",
      )
    ).rows;
    const exceptions = (
      await pool.query(
        "SELECT * FROM exceptions WHERE status='OPEN' ORDER BY created_at DESC LIMIT 200",
      )
    ).rows;
    const mappings = (
      await pool.query(
        "SELECT m.*,c.provider FROM sku_mappings m JOIN connections c ON c.id=m.connection_id ORDER BY m.external_sku",
      )
    ).rows;
    const asns = (
      await pool.query(
        "SELECT a.*,coalesce(json_agg(l) FILTER (WHERE l.sku IS NOT NULL),'[]') AS lines FROM asns a LEFT JOIN asn_lines l ON l.asn_id=a.id GROUP BY a.id ORDER BY created_at DESC",
      )
    ).rows;
    return {
      sequence: cursor,
      orders,
      inventory,
      connections,
      waves,
      shipments,
      exceptions,
      mappings,
      asns,
      server_time: new Date().toISOString(),
    };
  });
  app.get("/api/v1/orders", { preHandler: read }, async (req) => {
    const q = z
      .object({
        status: z.string().max(30).optional(),
        provider: z.string().max(20).optional(),
        search: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .parse(req.query);
    const r = await pool.query(
      "SELECT o.*,c.provider,c.mode FROM orders o JOIN connections c ON c.id=o.connection_id WHERE ($1::text IS NULL OR o.status=$1) AND ($2::text IS NULL OR c.provider=$2) AND ($3::text IS NULL OR o.external_id ILIKE '%'||$3||'%') ORDER BY o.created_at DESC LIMIT $4 OFFSET $5",
      [
        q.status || null,
        q.provider || null,
        q.search || null,
        q.limit,
        q.offset,
      ],
    );
    return { items: r.rows, limit: q.limit, offset: q.offset };
  });
  app.get("/api/v1/orders/:id", { preHandler: read }, async (req) =>
    domain.getOrder((req.params as any).id),
  );
  app.get("/api/v1/inventory", { preHandler: read }, async () => ({
    items: (
      await pool.query(
        "SELECT i.*,p.name,on_hand-reserved AS available FROM inventory i JOIN products p ON p.sku=i.sku ORDER BY sku,location",
      )
    ).rows,
  }));
  const version = z.object({ version: z.number().int().positive() }).strict();
  mutation("/api/v1/orders/:id/reserve", "fulfill", version, (b, a, id) =>
    domain.reserve(a, id, b.version),
  );
  mutation("/api/v1/orders/:id/ready", "fulfill", version, (b, a, id) =>
    domain.ready(a, id, b.version),
  );
  mutation(
    "/api/v1/orders/:id/cancel",
    "fulfill",
    version.extend({ reason: z.string().min(3).max(300) }),
    (b, a, id) => domain.cancel(a, id, b.version, b.reason),
  );
  mutation(
    "/api/v1/orders/:id/ship",
    "fulfill",
    version.extend({
      carrier: z.enum(["YESI Ground", "YESI Express", "Partner carrier"]),
    }),
    (b, a, id) => domain.bookShipment(a, id, b.version, b.carrier),
  );
  mutation(
    "/api/v1/waves",
    "fulfill",
    z
      .object({
        order_ids: z.array(z.uuid()).min(1).max(100),
        versions: z.record(z.uuid(), z.number().int().positive()),
      })
      .strict(),
    (b, a) => domain.createWave(a, b.order_ids, b.versions),
  );
  mutation(
    "/api/v1/waves/:id/complete",
    "fulfill",
    z.object({}).strict(),
    (b, a, id) => domain.completeWave(a, id),
  );
  mutation("/api/v1/shipments/:id/dispatch", "fulfill", version, (b, a, id) =>
    domain.dispatch(a, id, b.version),
  );
  mutation(
    "/api/v1/shipments/:id/tracking",
    "integrate",
    version.extend({ status: z.enum(["IN_TRANSIT", "DELIVERED"]) }),
    (b, a, id) => domain.tracking(a, id, b.status, b.version),
  );
  mutation(
    "/api/v1/sku-mappings",
    "mapping",
    z
      .object({
        connection_id: z.uuid(),
        external_sku: z.string().min(1).max(100),
        sku: z.string().min(1).max(100),
      })
      .strict(),
    (b, a) => domain.mapSku(a, b.connection_id, b.external_sku, b.sku),
  );
  mutation(
    "/api/v1/asns",
    "stock",
    z
      .object({
        supplier: z.string().min(1).max(160),
        lines: z
          .array(
            z
              .object({
                sku: z.string(),
                location: z.string().regex(/^[A-D]-\d{2}-\d{2}$/),
                expected: z.number().int().positive().max(100000),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    async (b, a) =>
      tx(async (c) => {
        const id = uid();
        await c.query("INSERT INTO asns(id,supplier) VALUES($1,$2)", [
          id,
          b.supplier,
        ]);
        for (const l of b.lines)
          await c.query(
            "INSERT INTO asn_lines(asn_id,sku,location,expected) VALUES($1,$2,$3,$4)",
            [id, l.sku, l.location, l.expected],
          );
        await audit(c, a, "asn.created", "asn", id, null, b);
        return { id };
      }),
  );
  mutation(
    "/api/v1/asns/:id/receive",
    "fulfill",
    z
      .object({
        lines: z
          .array(
            z
              .object({
                sku: z.string(),
                location: z.string(),
                quantity: z.number().int().positive().max(100000),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    (b, a, id) => domain.receiveAsn(a, id, b.lines),
  );
  mutation(
    "/api/v1/inventory/reconcile",
    "stock",
    z
      .object({
        sku: z.string(),
        location: z.string(),
        counted: z.number().int().nonnegative(),
        expected_version: z.number().int().positive(),
      })
      .strict(),
    (b, a) =>
      domain.reconcile(a, b.sku, b.location, b.counted, b.expected_version),
  );
  mutation(
    "/api/v1/exceptions/:id/approve-count",
    "stock",
    z.object({}).strict(),
    (b, a, id) => domain.approveCount(a, id),
  );
  mutation(
    "/api/v1/exceptions/:id/resolve",
    "supervisor",
    z.object({ note: z.string().min(3).max(500) }).strict(),
    async (b, a, id) =>
      tx(async (c) => {
        const e = await one(
          c,
          "SELECT * FROM exceptions WHERE id=$1 FOR UPDATE",
          [id],
        );
        if (e.kind === "COUNT_VARIANCE")
          fail(
            409,
            "APPROVAL_REQUIRED",
            "Count variances require explicit adjustment approval",
          );
        if (e.status !== "OPEN")
          fail(409, "ALREADY_RESOLVED", "Exception already resolved");
        await c.query(
          "UPDATE exceptions SET status='RESOLVED',resolved_at=now() WHERE id=$1",
          [id],
        );
        await audit(c, a, "exception.resolved", "exception", id, e, {
          note: b.note,
        });
        return { ok: true };
      }),
  );
  app.get("/api/v1/integrations", { preHandler: read }, async () => ({
    items: (
      await pool.query(
        "SELECT id,provider,account_id,mode,enabled,last_sync_at FROM connections",
      )
    ).rows,
    certification: "sandbox",
    docs: marketplaceDocs,
  }));
  mutation(
    "/api/v1/integrations",
    "integrate",
    z
      .object({
        provider: z.enum(["ozon", "yandex", "wildberries"]),
        account_id: z.string().min(1).max(100),
        webhook_secret: z.string().min(32).max(256),
        credentials: credentialsSchema.optional(),
      })
      .strict(),
    async (b, a) =>
      tx(async (c) => {
        if (b.credentials)
          fail(
            400,
            "CERTIFICATION_REQUIRED",
            "Native credentials require connector certification; use the signed sandbox gateway",
          );
        const id = uid();
        await c.query(
          "INSERT INTO connections(id,provider,account_id,mode,webhook_ciphertext) VALUES($1,$2,$3,'sandbox',$4)",
          [id, b.provider, b.account_id, encrypt(b.webhook_secret)],
        );
        await audit(c, a, "connection.created", "connection", id, null, {
          provider: b.provider,
          account_id: b.account_id,
          mode: "sandbox",
        });
        return { id, mode: "sandbox" };
      }),
  );
  app.post(
    "/api/v1/integrations/:id/ingest",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req) => {
      const id = (req.params as any).id;
      const conn = await one(
        pool,
        "SELECT * FROM connections WHERE id=$1 AND enabled",
        [id],
      );
      if (conn.mode !== "sandbox")
        fail(403, "CERTIFICATION_REQUIRED", "Live ingestion disabled");
      const signature = String(req.headers["x-yesi-signature"] || "");
      const expected =
        "sha256=" +
        createHmac("sha256", decrypt(conn.webhook_ciphertext))
          .update(req.rawBody || Buffer.alloc(0))
          .digest("hex");
      const actual = Buffer.from(signature);
      const exp = Buffer.from(expected);
      if (actual.length !== exp.length || !timingSafeEqual(actual, exp))
        fail(401, "INVALID_SIGNATURE", "Webhook signature verification failed");
      const actor: Actor = {
        id: "00000000-0000-0000-0000-000000000002",
        role: "integration",
        email: "connector@system",
        requestId: String(req.id),
      };
      return domain.ingest(id, req.body, actor);
    },
  );
  mutation(
    "/api/v1/integrations/:id/test-order",
    "integrate",
    z.object({}).strict(),
    async (b, a, id) => {
      const conn = await one(pool, "SELECT * FROM connections WHERE id=$1", [
        id,
      ]);
      if (conn.mode !== "sandbox")
        fail(403, "SANDBOX_ONLY", "Test orders are sandbox-only");
      const n = Date.now();
      const body = {
        event_id: "test-" + id + "-" + n,
        external_id: "TEST-" + n,
        customer_ref: "Sandbox customer",
        currency: "RUB",
        total_minor: 299000,
        ship_by: new Date(Date.now() + 86400000).toISOString(),
        lines: [
          { external_sku: "OZ-EARBUDS", quantity: 1, unit_price_minor: 299000 },
        ],
      };
      if (conn.provider === "yandex") body.lines[0].external_sku = "YM-EARBUDS";
      if (conn.provider === "wildberries")
        body.lines[0].external_sku = "WB-EARBUDS";
      return domain.ingest(id, body, a);
    },
  );
  app.get(
    "/api/v1/integrations/:id/raw",
    { preHandler: auth("integrate") },
    async (req) => ({
      items: (
        await pool.query(
          "SELECT id,external_event_id,payload_hash,received_at FROM raw_events WHERE connection_id=$1 ORDER BY received_at DESC LIMIT 100",
          [(req.params as any).id],
        )
      ).rows,
    }),
  );
  app.get("/api/v1/audit", { preHandler: auth("audit") }, async (req) => {
    const q = z
      .object({
        after: z.coerce.number().int().nonnegative().default(0),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query);
    return {
      items: (
        await pool.query(
          "SELECT * FROM audit_logs WHERE seq>$1 ORDER BY seq LIMIT $2",
          [q.after, q.limit],
        )
      ).rows,
    };
  });
  app.get("/api/v1/audit/verify", { preHandler: auth("audit") }, async () =>
    verifyAudit(),
  );
  app.get("/api/v1/outbox", { preHandler: auth("replay") }, async () => ({
    items: (
      await pool.query(
        "SELECT seq,id,topic,status,attempts,last_error,created_at,processed_at FROM outbox ORDER BY seq DESC LIMIT 200",
      )
    ).rows,
  }));
  mutation(
    "/api/v1/outbox/:id/replay",
    "replay",
    z.object({ reason: z.string().min(5).max(300) }).strict(),
    async (b, a, id) =>
      tx(async (c) => {
        const e = await one(c, "SELECT * FROM outbox WHERE id=$1 FOR UPDATE", [
          id,
        ]);
        if (e.status !== "DEAD")
          fail(409, "NOT_DEAD", "Only dead-letter events can be replayed");
        await c.query(
          "UPDATE outbox SET status='PENDING',attempts=0,next_attempt_at=now(),last_error=NULL,locked_at=NULL WHERE id=$1",
          [id],
        );
        await audit(c, a, "outbox.replayed", "event", id, e, {
          reason: b.reason,
        });
        return { ok: true };
      }),
  );
  app.get("/api/v1/events", { preHandler: read }, async (req) => {
    const q = z
      .object({ after: z.coerce.number().int().nonnegative().default(0) })
      .parse(req.query);
    const r = await pool.query(
      "SELECT seq,id,topic,payload,created_at FROM outbox WHERE seq>$1 ORDER BY seq LIMIT 500",
      [q.after],
    );
    return {
      items: r.rows.filter((e) => visible(e.topic, req.actor!.role)),
      has_more: r.rowCount === 500,
    };
  });
  app.get(
    "/api/v1/finance/journals",
    { preHandler: auth("finance") },
    async () => ({
      items: (
        await pool.query(
          "SELECT j.*,o.external_id,(SELECT e.status FROM outbox e WHERE e.topic='erp.post' AND e.payload->>'order_id'=o.id::text ORDER BY e.seq DESC LIMIT 1) AS delivery_status FROM journal_entries j JOIN orders o ON o.id=j.order_id ORDER BY posted_at DESC LIMIT 500",
        )
      ).rows,
    }),
  );
  app.get(
    "/api/v1/reconciliation",
    { preHandler: auth("finance") },
    async () => {
      const stock = (
        await pool.query(
          "SELECT i.sku,i.location,i.on_hand,i.reserved,coalesce(sum(l.delta_on_hand),0)::int AS ledger_on_hand,coalesce(sum(l.delta_reserved),0)::int AS ledger_reserved FROM inventory i LEFT JOIN stock_ledger l ON l.sku=i.sku AND l.location=i.location GROUP BY i.sku,i.location,i.on_hand,i.reserved ORDER BY i.sku",
        )
      ).rows;
      const finance = (
        await pool.query(
          "SELECT o.id,o.external_id,o.status,(SELECT count(*) FROM journal_entries j WHERE j.order_id=o.id)::int AS journals,(SELECT count(*) FROM outbox e WHERE e.topic='erp.post' AND e.payload->>'order_id'=o.id::text AND e.status='DONE')::int AS posted FROM orders o WHERE o.status IN ('SHIPPED','DELIVERED')",
        )
      ).rows;
      return {
        stock: stock.map((s) => ({
          ...s,
          matched:
            s.on_hand === s.ledger_on_hand && s.reserved === s.ledger_reserved,
        })),
        finance: finance.map((f) => ({
          ...f,
          matched: f.journals > 0 && f.posted > 0,
        })),
        checked_at: new Date().toISOString(),
      };
    },
  );
  app.get("/openapi.json", async () => ({
    openapi: "3.0.3",
    info: {
      title: "YESI Fulfillment Core",
      version: "0.1.0",
      description:
        "Sandbox reference API. Session cookie + X-CSRF-Token; mutations require Idempotency-Key. Signed gateway uses X-YESI-Signature HMAC-SHA256 of raw JSON.",
    },
    servers: [{ url: config.origin }],
    paths: Object.fromEntries(
      app
        .routesToJson()
        .map((r) => [
          r.url,
          {
            [r.method.toLowerCase()]: {
              summary: r.url,
              parameters: r.mutation
                ? [{ $ref: "#/components/parameters/IdempotencyKey" }]
                : [],
              requestBody: r.schema
                ? {
                    required: true,
                    content: { "application/json": { schema: r.schema } },
                  }
                : undefined,
              security: r.url.includes("/ingest")
                ? [{ webhookSignature: [] }]
                : [{ sessionCookie: [] }],
              responses: {
                "200": { description: "Success or idempotent replay" },
                "400": { description: "Validation error" },
                "401": { description: "Authentication required" },
                "403": { description: "RBAC or CSRF rejection" },
                "409": {
                  description: "State, version, stock, or idempotency conflict",
                },
              },
            },
          },
        ]),
    ),
    components: {
      securitySchemes: {
        sessionCookie: { type: "apiKey", in: "cookie", name: SESSION },
        webhookSignature: {
          type: "apiKey",
          in: "header",
          name: "X-YESI-Signature",
        },
      },
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 8, maxLength: 128 },
        },
      },
    },
  }));
  const realtime = attachRealtime(app);
  return { app, redis, listen: realtime.listen };
}
export function visible(topic: string, role: Role) {
  if (topic.startsWith("erp.")) return ["admin", "finance"].includes(role);
  return permissions.read.includes(role);
}
// Small, explicit route inventory for the contract; runtime validation remains authoritative.
declare module "fastify" {
  interface FastifyInstance {
    routesToJson(): { method: string; url: string }[];
  }
}
