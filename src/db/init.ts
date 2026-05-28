import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Pool } from 'pg';
import { logger } from '../util/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function initDb(pool: Pool): Promise<void> {
  const sql = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    logger.info('db.connected');
  } finally {
    client.release();
  }
}
