import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, verifyCsrf } from '../auth.js';
import { can, type Actor, type Permission } from '../config.js';
import { command, commandStandalone, fail, tx, type Client } from '../db/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
    rawBody?: Buffer;
  }
}

export type MutationContext = {
  actor: Actor;
  client: Client;
  body: any;
  id: string;
  req: FastifyRequest;
};

export type RouteDoc = {
  method: string;
  path: string;
  permission: Permission | 'webhook';
  schema?: unknown;
  description?: string;
};

export function guard(permission: Permission) {
  return async (req: FastifyRequest) => {
    req.actor = await authenticate(req);
    if (!can(req.actor.role, permission)) {
      fail(403, 'FORBIDDEN', `Your role (${req.actor.role}) cannot perform this action`);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) await verifyCsrf(req);
  };
}

const idempotencyKey = z.string().min(8).max(128);

export function mutation<T>(
  app: FastifyInstance,
  docs: RouteDoc[],
  options: {
    path: string;
    permission: Permission;
    schema?: z.ZodType;
    method?: 'POST' | 'PATCH' | 'PUT';
    description?: string;
    /** Set false for commands that make external calls and must not hold a transaction. */
    transactional?: boolean;
    handler: (context: MutationContext) => Promise<T>;
  },
) {
  const schema = options.schema ?? z.object({}).strict();
  const method = options.method ?? 'POST';
  docs.push({
    method,
    path: options.path,
    permission: options.permission,
    schema: z.toJSONSchema(schema),
    description: options.description,
  });
  const route = async (req: FastifyRequest) => {
    const actor = req.actor!;
    const parsedKey = idempotencyKey.safeParse(req.headers['idempotency-key']);
    if (!parsedKey.success) {
      fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Mutations require an Idempotency-Key header (8–128 characters)');
    }
    const key = parsedKey.data!;
    const body = schema.parse(req.body ?? {});
    const id = String((req.params as any)?.id ?? '');
    const scope = `${actor.id}:${method}:${options.path}`;
    if (options.transactional === false) {
      return commandStandalone(scope, key, { body, id }, () =>
        options.handler({ actor, client: null as any, body, id, req }),
      );
    }
    return tx((client) =>
      command(client, scope, key, { body, id }, () => options.handler({ actor, client, body, id, req })),
    );
  };
  if (method === 'POST') app.post(options.path, { preHandler: guard(options.permission) }, route);
  else if (method === 'PATCH') app.patch(options.path, { preHandler: guard(options.permission) }, route);
  else app.put(options.path, { preHandler: guard(options.permission) }, route);
}
