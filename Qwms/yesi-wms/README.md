# YESI Fulfillment OS

An event-driven fulfillment platform for **Ozon**, **Yandex Market** and **Wildberries**.
One auditable state machine for orders, stock, pick waves, carrier handovers and money —
with signed marketplace ingestion, idempotent commands and an exception queue that can
actually be replayed.

```
                  ┌───────────────────────────────────────────────────────────┐
  Ozon ─┐         │  Connector hub     raw_events (immutable)                 │
  Yandex ├─ HMAC ─►  signature verify ─► normalise ─► orders + mappings      │
  WB ────┘         │        │                    │                           │
                   │        └─ inbox dedupe      └─ reservations (append-only)│
                   │                                                           │
                   │  Operator console ── commands ──► state machines          │
                   │        ▲                │             │                   │
                   │        │ WebSocket      │             ▼                   │
                   │        └── outbox ◄─────┘     ledger · journals · audit   │
                   │               │                                           │
                   │               ├─► ERP postings (idempotent, retried)     │
                   │               ├─► TMS bookings & tracking                │
                   │               └─► marketplace status push                │
                   └───────────────────────────────────────────────────────────┘
```

## Quick start

```bash
npm install
npm run migrate      # forward-only, checksummed SQL migrations
npm run seed         # demo data through the real services (development only)
npm run dev          # API + console on http://localhost:3000
```

`npm run reset` deletes the local database and rebuilds migrations + seed.
`npm run build` bundles the console into `public/`; `npm run start` runs the API in
production mode (requires PostgreSQL and `NODE_ENV=production`).

The sandbox runs **PGlite** (PostgreSQL 18 compiled to WASM) behind
`server/db/driver.ts`. Production uses node-postgres with exactly the same SQL,
migrations and triggers. Configuration lives in `.env.example`.

## Demo identities

All demo users share the password `Yesi!Demo2026` and the TOTP secret
`YESI-FULFILLMENT-DEMO-2026` (base32). In development the sign-in screen can fetch a
live code for any demo identity.

| Email | Role | Can do |
| --- | --- | --- |
| `admin@yesi.local` | admin | everything, including dead-letter replay |
| `supervisor@yesi.local` | supervisor | fulfil, count, resolve exceptions |
| `warehouse@yesi.local` | warehouse | pick, pack, receive |
| `finance@yesi.local` | finance | journals, ERP, reconciliation |
| `integration@yesi.local` | integration | connectors, mappings, TMS |
| `viewer@yesi.local` | viewer | read-only control tower |

The seed builds 24 bins, 22 products, three connectors, 66+ approved mappings,
opening stock, two ASNs (one partial), and 18 marketplace orders that move through
reservation, wave picking, packing, carrier booking, dispatch, tracking and delivery —
including one cancellation and one cycle-count variance.

## Console

Fourteen surfaces, all backed by the same API:

`Control tower` · `Orders` · `Inventory` · `Warehouse` · `Receiving` · `Wave board` ·
`Shipping` · `Connector hub` · `SKU mapping` · `Exception queue` · `Finance & ERP` ·
`Reconciliation` · `Audit & events` · `Platform`

`Warehouse` is the slotting and flow view: live occupancy heat per bin with a bin
inspector, carrier performance measured against marketplace ship-by promises, order
cycle-time distribution, status mix, velocity leaders and the inbound dock schedule.

Press `⌘K` / `Ctrl-K` anywhere to jump. The console holds one consistent snapshot and
resumes the event stream from its sequence cursor, so a dropped socket triggers a
re-sync instead of stale data.

## Domain model

**Order states** (enforced by `order_transitions_allowed` plus a trigger):

```
RECEIVED → MAPPED → RESERVED → PICKING → PACKED → READY_TO_SHIP → SHIPPED → DELIVERED → RETURNED
                                   └──────────────► EXCEPTION (any active state)
Any pre-shipment state ────────────► CANCELLED
```

**Shipment states:** `CREATED → BOOKED → DISPATCHED → IN_TRANSIT → DELIVERED`
(plus `EXCEPTION`, and `CANCELLED` before handover).

**Invariants that are enforced in SQL, not by convention:**

- Stock only changes through `stock_ledger`; each movement carries a unique `request_key`.
- `inventory` is a projection: `on_hand`, `reserved`, `damaged` and a monotonic `version`.
- Reservations are append-only: they are `CONSUMED` or `RELEASED`, never deleted
  (migration `005_reservation_guard.sql`).
- `audit_logs`, `stock_ledger`, `order_transitions`, `shipment_events` and `journal_lines`
  reject `UPDATE` and `DELETE`.
- The audit chain hashes each entry with the previous hash under an advisory lock;
  `GET /api/v1/audit/verify` recomputes the whole chain.
- Journal entries must balance (`Σ debit = Σ credit`) before they can be posted.
- Every mutation requires an `Idempotency-Key`; a replay returns the stored response and a
  different body under the same key returns `409 IDEMPOTENCY_CONFLICT`.
- Events are published only after `COMMIT`, from the transactional outbox, with
  exponential backoff → `DEAD` → replay.

## Marketplace ingress

Webhooks are the only unauthenticated write path. Authenticity comes from HMAC:

```
POST /api/v1/integrations/{connectionId}/webhooks
x-yesi-timestamp: 1763912345
x-yesi-signature: sha256=<hmac_sha256(secret, "{timestamp}.{rawBody}")>
x-yesi-event-id:  optional provider event id
```

Wildberries and Yandex use their native header names (`x-wb-signature`,
`x-yandex-signature`) and sign the raw body without a timestamp. Anything outside the
`WEBHOOK_TOLERANCE_SECONDS` window is rejected. Payloads are stored verbatim in
`raw_events` before normalisation, so a bad adapter can always be re-run.

```bash
# sign and deliver a sample payload
node -e '
const {createHmac}=require("crypto");
const body=require("./sample.json");
const ts=Math.floor(Date.now()/1000);
const raw=JSON.stringify(body);
console.log(createHmac("sha256", process.env.SECRET).update(`${ts}.${raw}`).digest("hex"));
'
```

Outbound marketplace calls use stable idempotency keys, so retries are safe:
`status:{orderId}:{version}`, `stock:{connectionId}:{hash}`,
`ship:{shipmentId}:{provider}`, `pull:{connectionId}:{minute}`.

Live connectors are disabled by default. Set `ALLOW_LIVE_CONNECTORS=true` **and**
provide credentials; calls are HTTPS-only, follow no redirects, time out in 10s, and
every attempt is recorded in `provider_operations`.

## API conventions

- Base path `/api/v1`; OpenAPI 3.1 at `/openapi.json` (session required).
- Session cookie is `HttpOnly`, `SameSite=Strict`; every mutation also needs
  `X-CSRF-Token` (returned by `POST /auth/login` and `GET /auth/me`).
- Realtime: `POST /auth/ticket` → one-time 30s ticket → `ws://…/ws`
  with `{type:"authenticate", ticket, last_seq}`.
- Errors are structured: `{ error: { code, message, request_id } }` with deterministic
  codes (`ILLEGAL_TRANSITION`, `VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`,
  `CSRF_REJECTED`, `INVALID_SIGNATURE`, `REPLAY_REQUIRED`, …).
- Rate limits are per route and enforced by `@fastify/rate-limit`.

```bash
curl -s localhost:3000/api/v1/snapshot -H "cookie: yesi_session=…" | jq '.kpis'
curl -s -X POST localhost:3000/api/v1/integrations/$ID/simulate \
  -H "cookie: yesi_session=…" -H "x-csrf-token: …" \
  -H "idempotency-key: $(uuidgen)" -H 'content-type: application/json' \
  -d '{"scenario":"multi_line","seed":42}'
```

## Operations

| Endpoint | Purpose |
| --- | --- |
| `/health` · `/api/v1/health` | liveness + database + worker depth (503 when unhealthy) |
| `/metrics` | Prometheus counters, histograms and queue gauges |
| `/api/v1/reconciliation` | live integrity proof with findings |
| `POST /api/v1/reconciliation/run` | run the sweep now and record it |
| `/api/v1/audit/verify` | recompute the audit hash chain |
| `/api/v1/outbox` | outbox by status, topic totals, worker depth |
| `POST /api/v1/outbox/:id/replay` | replay a dead event |

The embedded worker runs the outbox pump, scheduled connector pulls, autopilot
(development only, one balanced step every 30 s) and minute-by-minute reconciliation. Run it separately with `npm run worker`
and set `WORKER_ENABLED=false` on API nodes to scale horizontally.

## Testing

```bash
npm test        # black-box API proofs, SSR render and a live console walk-through
npm run check   # typecheck server and web separately
npm run build   # production bundle
```

The integration suite boots the real app against a throwaway database and proves:
SQL state-machine rejection, nested transaction rollback, reservation immutability,
idempotent replay and conflict detection, signed webhook acceptance/duplication/
rejection, audit chain verification and a balanced reconciliation report.

`tests/ui-render.test.tsx` server-renders every surface against a captured API
snapshot. `tests/console.test.tsx` goes further: it starts a real server, mounts the
React app in jsdom, signs in through the API and clicks through all fourteen pages,
failing on any console error. Together they catch missing snapshot relations that
typechecking cannot.

## Repository map

```
server/
  migrations/        001 identity · 002 catalog/inventory · 003 orders/fulfilment
                     004 finance · 005 reservation immutability
  db/                PGlite / node-postgres driver, tx() with post-commit publish
  domain/            orders, mapping, inventory, fulfilment, finance
  integrations/      adapters, ingestion, credentials, transport, hub, webhooks
  api/               auth, orders, integrations, platform, OpenAPI registry
  auth.ts            scrypt, TOTP, sessions, CSRF, WS tickets, OIDC PKCE
  worker.ts          outbox pump, retries, dead letters, scheduled pulls
  reconcile.ts       independent integrity assertions
  seed.ts            demo dataset built through the public services
web/                 React 19 console (Design system in styles.css)
tests/               backbone · ui-render · console runtime · snapshot fixture
```

## Production checklist

- Point `DATABASE_URL` at PostgreSQL 16+; run `npm run migrate` as a deploy step.
- Set a 32-byte `MASTER_KEY` (base64) and keep `MASTER_KEY_ID` for rotation.
- Configure `APP_ORIGIN`, TLS termination, and `AUTH_MODE=oidc` if using an IdP.
- Disable `AUTO_SEED`; demo identities are refused outside development.
- Connector pulls default to 90 s (`CONNECTOR_POLL_INTERVAL_MS`) and the sandbox
  autopilot to 30 s (`AUTOPILOT_INTERVAL_MS`); shrink them for near-real-time
  ingestion and widen them when marketplaces rate-limit you.
- Ship `/metrics` to Prometheus, alerts on `outbox_dead`, `exceptions_open`,
  `reconciliation_findings` and `http_request_duration`.
- Route exception queues to owners; replay requires the `replay` permission and is
  always audited.
- For multi-node fan-out, enable Redis and set `REDIS_URL` (LISTEN/NOTIFY remains the
  correctness path; Redis is the accelerator).
