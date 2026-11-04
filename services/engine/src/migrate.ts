import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { database, transaction, type Db } from './db.js';
export async function migrate(db: Db) {
  await transaction(db, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('pactpilot:migrations', 0))");
    await c.query('CREATE TABLE IF NOT EXISTS engine_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(x => x.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const old = await c.query('SELECT checksum FROM engine_migrations WHERE name=$1', [name]);
      if (old.rowCount) { if (old.rows[0].checksum !== checksum) throw new Error(`Migration changed: ${name}`); continue; }
      await c.query(sql);
      await c.query('INSERT INTO engine_migrations(name,checksum) VALUES ($1,$2)', [name, checksum]);
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = database(process.env.DATABASE_URL ?? '');
  try { await migrate(db); console.log('Engine migrations applied'); }
  catch { console.error('Migration failed; check database configuration and migration checksums'); process.exitCode = 1; }
  finally { await db.end(); }
}
