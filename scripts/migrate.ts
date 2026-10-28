import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const lockClient = await pool.connect();
try {
  await lockClient.query('SELECT pg_advisory_lock(831204177)');
  const directory = join(process.cwd(), 'apps', 'api', 'migrations');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const exists = await lockClient.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='schema_migrations'");
    if (exists.rowCount) {
      const applied = await lockClient.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file]);
      if (applied.rowCount) continue;
    }
    const sql = await readFile(join(directory, file), 'utf8');
    const client = lockClient;
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      await client.query('COMMIT');
      console.log(`Migração aplicada: ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await lockClient.query('SELECT pg_advisory_unlock(831204177)').catch(() => undefined);
  lockClient.release();
  await pool.end();
}
