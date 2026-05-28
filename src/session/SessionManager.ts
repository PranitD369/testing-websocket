import { Session } from './Session.js';
import { newSessionId } from '../util/ids.js';
import { logger } from '../util/logger.js';
import type { SessionStore } from './store.js';

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    ttlHours: number,
    private readonly store: SessionStore,
  ) {
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.sweeper = setInterval(() => void this.sweep(), 5 * 60 * 1000);
    this.sweeper.unref?.();
  }

  /**
   * Get an existing session by id (in-memory hit, then store rehydrate), or create a new one.
   * If id is provided but unknown, a new session is created with that id (allowing client to choose).
   */
  async getOrCreate(id?: string): Promise<Session> {
    if (id) {
      const existing = this.sessions.get(id);
      if (existing) {
        existing.touch();
        return existing;
      }
      const snap = await this.store.load(id);
      if (snap) {
        const rehydrated = new Session(snap.id, snap.createdAt);
        rehydrated.lastActivity = snap.lastActivity;
        rehydrated.resumptionHandle = snap.resumptionHandle;
        rehydrated.mode = snap.mode;
        rehydrated.transcript = snap.transcript;
        this.attachHooks(rehydrated);
        this.sessions.set(snap.id, rehydrated);
        rehydrated.touch();
        logger.info(
          { sessionId: snap.id, turns: snap.transcript.length },
          'session.loaded.from-db',
        );
        return rehydrated;
      }
      const fresh = new Session(id);
      this.attachHooks(fresh);
      this.sessions.set(id, fresh);
      await this.store.save(fresh);
      logger.info({ sessionId: id }, 'session.created.from-client-id');
      return fresh;
    }
    const newId = newSessionId();
    const fresh = new Session(newId);
    this.attachHooks(fresh);
    this.sessions.set(newId, fresh);
    await this.store.save(fresh);
    logger.info({ sessionId: newId }, 'session.created');
    return fresh;
  }

  /**
   * In-memory lookup only. Used by the photo fallback which is a one-shot REST handler
   * where the live WS bridge has already loaded the session.
   */
  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (s) s.touch();
    return s;
  }

  /**
   * Load a session for read-only use even if it's not currently in memory (e.g. the live
   * WS dropped and the user is now hitting the photo fallback on a session that was
   * evicted). Returns undefined if not in the store either.
   */
  async getOrLoad(id: string): Promise<Session | undefined> {
    const inMem = this.sessions.get(id);
    if (inMem) {
      inMem.touch();
      return inMem;
    }
    const snap = await this.store.load(id);
    if (!snap) return undefined;
    const rehydrated = new Session(snap.id, snap.createdAt);
    rehydrated.lastActivity = snap.lastActivity;
    rehydrated.resumptionHandle = snap.resumptionHandle;
    rehydrated.mode = snap.mode;
    rehydrated.transcript = snap.transcript;
    this.attachHooks(rehydrated);
    this.sessions.set(snap.id, rehydrated);
    rehydrated.touch();
    return rehydrated;
  }

  async remove(id: string): Promise<void> {
    this.sessions.delete(id);
    await this.store.remove(id);
  }

  size(): number {
    return this.sessions.size;
  }

  private attachHooks(session: Session): void {
    session.setHooks({
      onTurn: (turn) => {
        void this.store.appendTurn(session.id, turn);
      },
      onHandleChange: (handle) => {
        void this.store.saveHandle(session.id, handle);
      },
      onTouch: (at) => {
        void this.store.touch(session.id, at);
      },
    });
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const cutoff = now - this.ttlMs;
    let removed = 0;
    for (const [id, s] of this.sessions) {
      if (s.lastActivity < cutoff) {
        this.sessions.delete(id);
        removed++;
      }
    }
    try {
      const dbRemoved = await this.store.removeExpired(cutoff);
      if (removed > 0 || dbRemoved > 0) {
        logger.info(
          { removed, dbRemoved, remaining: this.sessions.size },
          'session.sweep',
        );
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'session.sweep.db-failed');
    }
  }

  stop(): void {
    clearInterval(this.sweeper);
  }
}
