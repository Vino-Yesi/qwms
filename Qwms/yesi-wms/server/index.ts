/**
 * API process bootstrap.
 *
 * Development and the sandbox preview run an embedded worker so a single
 * process is a complete, durable system. Production runs the API and the worker
 * as separate deployments against PostgreSQL.
 */
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './api/index.js';
import { config } from './config.js';
import { db, maybeOne } from './db/index.js';
import { publishEvent } from './bus.js';
import { migrate } from './migrate.js';
import { seedDatabase } from './seed.js';
import { startWorker } from './worker.js';

await migrate();
if (config.development && config.autoSeed) {
  const seeded = await seedDatabase();
  if (seeded.seeded) console.log(JSON.stringify({ level: 'info', component: 'seed', message: 'Sandbox dataset ready' }));
}

const { app, close } = await buildApp();
const publicDir = resolve(process.cwd(), 'public');
if (existsSync(publicDir)) {
  await app.register(fastifyStatic, { root: publicDir, wildcard: false, index: ['index.html'] });
}
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/health') || req.url === '/metrics') {
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Endpoint not found', request_id: String(req.id) } });
  }
  if (existsSync(resolve(publicDir, 'index.html'))) return reply.sendFile('index.html');
  return reply
    .code(404)
    .send({ error: { code: 'UI_NOT_BUILT', message: 'Run `npm run build` or open the Vite dev server on port 5173.' } });
});

await app.listen({ port: config.port, host: '0.0.0.0' });

// Multi-instance fan-out: PostgreSQL LISTEN/NOTIFY feeds the local WebSocket bus.
if (db.kind === 'postgres') {
  await db.listen('yesi_events', async (seq) => {
    const row = await maybeOne<any>(db, 'SELECT * FROM outbox WHERE seq=$1', [Number(seq)]);
    if (!row) return;
    publishEvent({
      seq: Number(row.seq),
      id: row.id,
      topic: row.topic,
      aggregate_type: row.aggregate_type,
      aggregate_id: row.aggregate_id,
      payload: row.payload,
      headers: row.headers,
      created_at: new Date(row.created_at).toISOString(),
    });
  });
}

const worker = config.workerEnabled ? await startWorker({ embedded: true }) : null;
console.log(
  JSON.stringify({
    level: 'info',
    message: 'YESI Fulfillment OS ready',
    port: config.port,
    database: db.kind,
    environment: config.env,
    connectors: config.connectorMode,
    worker: Boolean(worker),
  }),
);

const shutdown = async (signal: string) => {
  console.log(JSON.stringify({ level: 'info', message: 'Shutting down', signal }));
  setTimeout(() => process.exit(1), 15_000).unref();
  await worker?.stop();
  await close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
