import { Session } from './Session.js';
import { newSessionId } from '../util/ids.js';
import { logger } from '../util/logger.js';

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;
  private readonly sweeper: NodeJS.Timeout;

  constructor(ttlHours: number) {
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.sweeper = setInterval(() => this.sweep(), 5 * 60 * 1000);
    this.sweeper.unref?.();
  }

  /** Get an existing session by id, or create a new one. If id is provided but unknown, a new session is created with that id (allowing client to choose). */
  getOrCreate(id?: string): Session {
    if (id) {
      const existing = this.sessions.get(id);
      if (existing) {
        existing.touch();
        return existing;
      }
      const fresh = new Session(id);
      this.sessions.set(id, fresh);
      logger.info({ sessionId: id }, 'session.created.from-client-id');
      return fresh;
    }
    const newId = newSessionId();
    const fresh = new Session(newId);
    this.sessions.set(newId, fresh);
    logger.info({ sessionId: newId }, 'session.created');
    return fresh;
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (s) s.touch();
    return s;
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  size(): number {
    return this.sessions.size;
  }

  private sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > this.ttlMs) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if (removed > 0) logger.info({ removed, remaining: this.sessions.size }, 'session.sweep');
  }

  stop(): void {
    clearInterval(this.sweeper);
  }
}
