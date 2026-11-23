/** Forward-only, checksummed migrations. Runs inside one transaction per file. */
import { readFileSync, readdirSync } from 'node:fs';
import { db, hash } from './db/index.js';

export async function migrate(log = true): Promise<string[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename text PRIMARY KEY,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const directory = new URL('./migrations/', import.meta.url);
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const sql = readFileSync(new URL(file, directory), 'utf8');
    const checksum = hash(sql);
    const existing = await db.query('SELECT checksum FROM schema_migrations WHERE filename=$1', [file]);
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Migration ${file} was modified after being applied. Add a new migration instead.`);
      }
      continue;
    }
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations(filename, checksum) VALUES('${file}','${checksum}');\nCOMMIT;`);
    applied.push(file);
    if (log) console.log(JSON.stringify({ level: 'info', component: 'migrate', applied: file }));
  }
  return applied;
}

if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  await migrate();
  await db.end();
}
