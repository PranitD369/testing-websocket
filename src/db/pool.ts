import pg from 'pg';
import { logger } from '../util/logger.js';

let pool: pg.Pool | null = null;

export function initPool(connectionString: string, max: number): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({ connectionString, max });
  pool.on('error', (err) => {
    logger.warn({ err: err.message }, 'db.pool.error');
  });
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('db pool not initialized');
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
