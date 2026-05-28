import type { Pool } from 'pg';
import type { Session, Turn } from './Session.js';
import type { SessionSnapshot, SessionStore } from './store.js';
import type { Mode } from '../gemini/liveTypes.js';
import { logger } from '../util/logger.js';

interface SessionRow {
  id: string;
  created_at: Date;
  last_activity: Date;
  resumption_handle: string | null;
  mode: string;
}

interface TurnRow {
  role: string;
  text: string;
  at: Date;
}

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async load(id: string): Promise<SessionSnapshot | null> {
    const sessionRes = await this.pool.query<SessionRow>(
      'SELECT id, created_at, last_activity, resumption_handle, mode FROM sessions WHERE id = $1',
      [id],
    );
    const row = sessionRes.rows[0];
    if (!row) return null;

    const turnsRes = await this.pool.query<TurnRow>(
      'SELECT role, text, at FROM turns WHERE session_id = $1 ORDER BY at ASC, id ASC',
      [id],
    );

    const transcript: Turn[] = turnsRes.rows.map((r) => ({
      role: r.role as 'user' | 'model',
      text: r.text,
      at: r.at.getTime(),
    }));

    return {
      id: row.id,
      createdAt: row.created_at.getTime(),
      lastActivity: row.last_activity.getTime(),
      resumptionHandle: row.resumption_handle ?? undefined,
      mode: row.mode as Mode,
      transcript,
    };
  }

  async save(session: Session): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, created_at, last_activity, resumption_handle, mode)
       VALUES ($1, to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         last_activity = EXCLUDED.last_activity,
         resumption_handle = EXCLUDED.resumption_handle,
         mode = EXCLUDED.mode`,
      [
        session.id,
        session.createdAt,
        session.lastActivity,
        session.resumptionHandle ?? null,
        session.mode,
      ],
    );
  }

  async appendTurn(sessionId: string, turn: Turn): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO turns (session_id, role, text, at) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))',
        [sessionId, turn.role, turn.text, turn.at],
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message, sessionId }, 'db.appendTurn.failed');
    }
  }

  async saveHandle(sessionId: string, handle: string | undefined): Promise<void> {
    try {
      await this.pool.query('UPDATE sessions SET resumption_handle = $1 WHERE id = $2', [
        handle ?? null,
        sessionId,
      ]);
    } catch (err) {
      logger.warn({ err: (err as Error).message, sessionId }, 'db.saveHandle.failed');
    }
  }

  async touch(sessionId: string, at: number): Promise<void> {
    try {
      await this.pool.query(
        'UPDATE sessions SET last_activity = to_timestamp($1 / 1000.0) WHERE id = $2',
        [at, sessionId],
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message, sessionId }, 'db.touch.failed');
    }
  }

  async remove(id: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE id = $1', [id]);
  }

  async removeExpired(beforeMs: number): Promise<number> {
    const res = await this.pool.query(
      'DELETE FROM sessions WHERE last_activity < to_timestamp($1 / 1000.0)',
      [beforeMs],
    );
    return res.rowCount ?? 0;
  }

  async close(): Promise<void> {
    // Pool lifecycle is owned by db/pool.ts; don't end it here.
  }
}
