import type { Session, Turn } from './Session.js';
import type { SessionSnapshot, SessionStore } from './store.js';

/**
 * Volatile fallback for when DATABASE_URL is not configured. Sessions still survive
 * within a single process; reconnects work as before. Cross-restart durability requires
 * the Postgres store.
 */
export class MemorySessionStore implements SessionStore {
  private readonly data = new Map<string, SessionSnapshot>();

  async load(id: string): Promise<SessionSnapshot | null> {
    const snap = this.data.get(id);
    if (!snap) return null;
    return { ...snap, transcript: [...snap.transcript] };
  }

  async save(session: Session): Promise<void> {
    this.data.set(session.id, {
      id: session.id,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      resumptionHandle: session.resumptionHandle,
      mode: session.mode,
      transcript: [...session.transcript],
    });
  }

  async appendTurn(sessionId: string, turn: Turn): Promise<void> {
    const snap = this.data.get(sessionId);
    if (!snap) return;
    snap.transcript.push(turn);
  }

  async saveHandle(sessionId: string, handle: string | undefined): Promise<void> {
    const snap = this.data.get(sessionId);
    if (!snap) return;
    snap.resumptionHandle = handle;
  }

  async touch(sessionId: string, at: number): Promise<void> {
    const snap = this.data.get(sessionId);
    if (!snap) return;
    snap.lastActivity = at;
  }

  async remove(id: string): Promise<void> {
    this.data.delete(id);
  }

  async removeExpired(beforeMs: number): Promise<number> {
    let removed = 0;
    for (const [id, snap] of this.data) {
      if (snap.lastActivity < beforeMs) {
        this.data.delete(id);
        removed++;
      }
    }
    return removed;
  }

  async close(): Promise<void> {
    this.data.clear();
  }
}
