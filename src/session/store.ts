import type { Session, Turn } from './Session.js';
import type { Mode } from '../gemini/liveTypes.js';

export interface SessionSnapshot {
  id: string;
  createdAt: number;
  lastActivity: number;
  resumptionHandle?: string;
  mode: Mode;
  transcript: Turn[];
}

/**
 * Durable backing store for sessions. The in-memory `SessionManager` holds the live
 * objects; this interface exists so we can persist them to Postgres (production)
 * or skip persistence entirely (tests / no-DB local).
 */
export interface SessionStore {
  load(id: string): Promise<SessionSnapshot | null>;
  save(session: Session): Promise<void>;
  appendTurn(sessionId: string, turn: Turn): Promise<void>;
  saveHandle(sessionId: string, handle: string | undefined): Promise<void>;
  touch(sessionId: string, at: number): Promise<void>;
  remove(id: string): Promise<void>;
  removeExpired(beforeMs: number): Promise<number>;
  close(): Promise<void>;
}
