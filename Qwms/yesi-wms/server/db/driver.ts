/**
 * Storage driver.
 *
 * Production runs on PostgreSQL (connection pool, LISTEN/NOTIFY, multiple API
 * and worker processes). Development, CI and the sandbox preview run on PGlite,
 * an embedded WASM build of real PostgreSQL. Both speak the same SQL, use the
 * same migrations and enforce the same triggers, so the integrity guarantees
 * exercised by tests are the ones that ship.
 *
 * PGlite has a single connection, so client acquisition is serialized. That is
 * a correctness feature for the embedded build: transactions cannot interleave.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export type Row = Record<string, any>;
export interface QueryResult {
  rows: Row[];
  rowCount: number;
}
export interface Queryable {
  query(sql: string, params?: any[]): Promise<QueryResult>;
}
export interface Client extends Queryable {
  release(): void;
}
export interface Database extends Queryable {
  readonly kind: 'postgres' | 'pglite';
  connect(): Promise<Client>;
  exec(sql: string): Promise<void>;
  listen(channel: string, handler: (payload: string) => void): Promise<() => void>;
  end(): Promise<void>;
}

/** Postgres returns int8 as strings and PGlite as BigInt; normalise both. */
function normalizeRows(rows: Row[]): Row[] {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (typeof value === 'bigint') {
        row[key] = value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(value)
          : value.toString();
      }
    }
  }
  return rows;
}

class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];
  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.locked = false;
  }
}

function postgresDatabase(url: string): Database {
  // Loaded lazily so the embedded build never pays for it.
  let pool: any;
  const ready = (async () => {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: url, max: 20, statement_timeout: 15000, idleTimeoutMillis: 30000 });
  })();
  const api: Database = {
    kind: 'postgres',
    async query(sql, params) {
      await ready;
      const result = await pool.query(sql, params);
      return { rows: normalizeRows(result.rows), rowCount: result.rowCount ?? 0 };
    },
    async connect() {
      await ready;
      const client = await pool.connect();
      return {
        async query(sql, params) {
          const result = await client.query(sql, params);
          return { rows: normalizeRows(result.rows), rowCount: result.rowCount ?? 0 };
        },
        release() {
          client.release();
        },
      };
    },
    async exec(sql) {
      await ready;
      await pool.query(sql);
    },
    async listen(channel, handler) {
      await ready;
      const client = await pool.connect();
      client.on('notification', (message: any) => {
        if (message.channel === channel && message.payload) handler(message.payload);
      });
      await client.query(`LISTEN ${channel}`);
      return async () => {
        try {
          await client.query(`UNLISTEN ${channel}`);
        } finally {
          client.release();
        }
      };
    },
    async end() {
      await ready;
      await pool.end();
    },
  };
  return api;
}

async function pgliteDatabase(dataDir: string): Promise<Database> {
  const { PGlite } = await import('@electric-sql/pglite');
  let db: any;
  if (dataDir === ':memory:') {
    db = new PGlite();
  } else {
    const target = resolve(process.cwd(), dataDir);
    if (!existsSync(target)) mkdirSync(target, { recursive: true });
    db = new PGlite(target);
  }
  await db.waitReady;
  const mutex = new Mutex();
  const api: Database = {
    kind: 'pglite',
    async query(sql, params) {
      await mutex.acquire();
      try {
        const result = await db.query(sql, params);
        return {
          rows: normalizeRows(result.rows ?? []),
          rowCount: result.affectedRows ?? result.rowCount ?? result.rows?.length ?? 0,
        };
      } finally {
        mutex.release();
      }
    },
    async connect() {
      await mutex.acquire();
      let released = false;
      return {
        async query(sql, params) {
          const result = await db.query(sql, params);
          return {
            rows: normalizeRows(result.rows ?? []),
            rowCount: result.affectedRows ?? result.rowCount ?? result.rows?.length ?? 0,
          };
        },
        release() {
          if (released) return;
          released = true;
          mutex.release();
        },
      };
    },
    async exec(sql) {
      await mutex.acquire();
      try {
        await db.exec(sql);
      } finally {
        mutex.release();
      }
    },
    async listen() {
      // PGlite is embedded: the in-process bus is the only subscriber.
      return async () => {};
    },
    async end() {
      await db.close();
    },
  };
  return api;
}

export async function createDatabase(connectionString: string): Promise<Database> {
  if (/^postgres(ql)?:\/\//.test(connectionString)) return postgresDatabase(connectionString);
  if (connectionString.startsWith('pglite://')) {
    return pgliteDatabase(connectionString.slice('pglite://'.length) || '.data/yesi');
  }
  throw new Error(`Unsupported DATABASE_URL (expected postgresql:// or pglite://): ${connectionString.slice(0, 24)}…`);
}
