import pg, { type PoolClient } from 'pg';
export type Db = pg.Pool;
export type Sql = Pick<PoolClient, 'query'>;
export function database(url: string): Db { return new pg.Pool({ connectionString: url, max: 10 }); }
export async function transaction<T>(db: Db, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) { await c.query('ROLLBACK'); throw error; }
  finally { c.release(); }
}
export function publicRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase()), v]));
}
