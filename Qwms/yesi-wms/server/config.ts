/** Environment configuration and the single source of truth for RBAC. */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

const env = process.env;
const DEMO_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const nodeEnv = env.NODE_ENV || 'development';
const development = nodeEnv !== 'production';

const config = {
  env: nodeEnv,
  development,
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || 'pglite://.data/yesi',
  appOrigin: env.APP_ORIGIN || '',
  masterKey: Buffer.from(env.MASTER_KEY || DEMO_KEY, 'base64'),
  keyId: env.MASTER_KEY_ID || 'k1',
  authMode: (env.AUTH_MODE || 'local') as 'local' | 'oidc',
  oidcIssuer: env.OIDC_ISSUER_URL || '',
  oidcClient: env.OIDC_CLIENT_ID || '',
  oidcSecret: env.OIDC_CLIENT_SECRET || '',
  sessionMinutes: Number(env.SESSION_MINUTES || 30),
  redisUrl: env.REDIS_URL || '',
  metricsToken: env.METRICS_TOKEN || '',
  // Connectors default to sandbox: every outbound call is acknowledged by the
  // deterministic simulator. Live mode is only reachable with an explicit
  // certification flag, and production refuses to boot without credentials.
  connectorMode: (env.CONNECTORS_MODE || 'sandbox') as 'sandbox' | 'live',
  allowLiveConnectors: env.ALLOW_LIVE_CONNECTORS === 'true',
  erpEndpoint: env.ERP_ENDPOINT || '',
  erpSecret: env.ERP_SECRET || '',
  tmsEndpoint: env.TMS_ENDPOINT || '',
  tmsSecret: env.TMS_SECRET || '',
  tmsWebhookSecret: env.TMS_WEBHOOK_SECRET || '',
  webhookToleranceSeconds: Number(env.WEBHOOK_TOLERANCE_SECONDS || 300),
  pollIntervalMs: Number(env.CONNECTOR_POLL_INTERVAL_MS || 90000),
  autopilotIntervalMs: Number(env.AUTOPILOT_INTERVAL_MS || 30000),
  workerEnabled: env.WORKER_ENABLED !== 'false',
  autoSeed: env.AUTO_SEED !== 'false',
  simulateTraffic: env.SIMULATE_TRAFFIC === 'true',
} as const;

if (config.masterKey.length !== 32) throw new Error('MASTER_KEY must decode to exactly 32 bytes');

if (!development) {
  if (config.authMode !== 'oidc' || !config.oidcIssuer || !config.oidcClient || !config.oidcSecret) {
    throw new Error('Production requires a fully configured OIDC provider (AUTH_MODE=oidc)');
  }
  if (!/^https:\/\//.test(config.appOrigin)) throw new Error('Production requires an https:// APP_ORIGIN');
  if (!/^postgres(ql)?:\/\//.test(config.databaseUrl)) throw new Error('Production requires PostgreSQL');
  if (env.MASTER_KEY === undefined || env.MASTER_KEY === DEMO_KEY) {
    throw new Error('Production refuses the public demo MASTER_KEY');
  }
  if (!config.metricsToken) throw new Error('Production requires METRICS_TOKEN to protect /metrics');
  if (config.connectorMode === 'live' && !config.allowLiveConnectors) {
    throw new Error('Live connectors require ALLOW_LIVE_CONNECTORS=true after marketplace certification');
  }
  if (config.tmsEndpoint && !config.tmsWebhookSecret) {
    throw new Error('A live TMS integration requires TMS_WEBHOOK_SECRET to verify tracking callbacks');
  }
}

export { config };

export type Role = 'admin' | 'supervisor' | 'warehouse' | 'finance' | 'integration' | 'viewer';
export type Permission =
  | 'read'
  | 'fulfill'
  | 'stock'
  | 'mapping'
  | 'integrate'
  | 'finance'
  | 'audit'
  | 'replay'
  | 'supervise'
  | 'admin';

/** Least privilege. Every route declares exactly one permission. */
export const permissions: Record<Permission, Role[]> = {
  read: ['admin', 'supervisor', 'warehouse', 'finance', 'integration', 'viewer'],
  fulfill: ['admin', 'supervisor', 'warehouse'],
  stock: ['admin', 'supervisor'],
  mapping: ['admin', 'supervisor'],
  integrate: ['admin', 'integration'],
  finance: ['admin', 'finance'],
  audit: ['admin'],
  replay: ['admin', 'integration'],
  supervise: ['admin', 'supervisor'],
  admin: ['admin'],
};

export const can = (role: string, permission: Permission): boolean =>
  (permissions[permission] || []).includes(role as Role);

export type Actor = {
  id: string;
  role: Role;
  email: string;
  requestId: string;
  type: 'user' | 'system' | 'connector';
  ip?: string;
};

/** Identity used by the worker for effects that have no human in the loop. */
export const SYSTEM_ACTOR: Actor = {
  id: '00000000-0000-0000-0000-000000000001',
  role: 'integration',
  email: 'worker@system',
  requestId: 'worker',
  type: 'system',
};

export type ConnectorProvider = 'ozon' | 'yandex' | 'wildberries';
export const providers: ConnectorProvider[] = ['ozon', 'yandex', 'wildberries'];
