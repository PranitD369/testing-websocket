import { describe, it, expect } from 'vitest';
import { SessionManager } from '../src/session/SessionManager.js';
import { MemorySessionStore } from '../src/session/memoryStore.js';
import { Session } from '../src/session/Session.js';

function makeManager(): SessionManager {
  return new SessionManager(24, new MemorySessionStore());
}

describe('SessionManager', () => {
  it('returns the same session when called twice with same id', async () => {
    const sm = makeManager();
    const a = await sm.getOrCreate('s1');
    const b = await sm.getOrCreate('s1');
    expect(a).toBe(b);
    sm.stop();
  });

  it('mints a new id when none provided', async () => {
    const sm = makeManager();
    const a = await sm.getOrCreate();
    const b = await sm.getOrCreate();
    expect(a.id).not.toBe(b.id);
    sm.stop();
  });

  it('persists resumption handle across re-fetch', async () => {
    const sm = makeManager();
    const s = await sm.getOrCreate('s1');
    s.setResumptionHandle('h-1');
    const again = await sm.getOrCreate('s1');
    expect(again.resumptionHandle).toBe('h-1');
    sm.stop();
  });

  it('records turns and produces a summary', async () => {
    const sm = makeManager();
    const s = await sm.getOrCreate('s1');
    s.recordTurn('user', 'what is this part?');
    s.recordTurn('model', 'it is a capacitor');
    const summary = s.transcriptSummary();
    expect(summary).toContain('user: what is this part?');
    expect(summary).toContain('model: it is a capacitor');
    sm.stop();
  });

  it('rehydrates a session from the store when it is not in memory', async () => {
    const store = new MemorySessionStore();
    const sm1 = new SessionManager(24, store);
    const s1 = await sm1.getOrCreate('s-cross');
    s1.recordTurn('user', 'before restart');
    s1.recordTurn('model', 'reply before restart');
    s1.setResumptionHandle('handle-x');
    sm1.stop();

    // New manager, same store -> simulates server restart.
    const sm2 = new SessionManager(24, store);
    const s2 = await sm2.getOrCreate('s-cross');
    expect(s2.transcript).toHaveLength(2);
    expect(s2.transcript[0]?.text).toBe('before restart');
    expect(s2.resumptionHandle).toBe('handle-x');
    sm2.stop();
  });
});

describe('Session.buildSeedContext', () => {
  it('returns empty for an empty transcript', () => {
    const s = new Session('x');
    expect(s.buildSeedContext(3)).toEqual({ summary: '', replay: [] });
  });

  it('puts everything into replay when transcript fits in the tail', () => {
    const s = new Session('x');
    s.recordTurn('user', 'q1');
    s.recordTurn('model', 'a1');
    const ctx = s.buildSeedContext(3);
    expect(ctx.summary).toBe('');
    expect(ctx.replay).toHaveLength(2);
    expect(ctx.replay[0]?.text).toBe('q1');
  });

  it('splits older turns into summary and keeps the last N as replay', () => {
    const s = new Session('x');
    s.recordTurn('user', 'q1');
    s.recordTurn('model', 'a1');
    s.recordTurn('user', 'q2');
    s.recordTurn('model', 'a2');
    s.recordTurn('user', 'q3');
    s.recordTurn('model', 'a3');
    const ctx = s.buildSeedContext(3);
    expect(ctx.replay).toHaveLength(3);
    expect(ctx.replay.map((t) => t.text)).toEqual(['a2', 'q3', 'a3']);
    expect(ctx.summary).toContain('user: q1');
    expect(ctx.summary).toContain('model: a1');
    expect(ctx.summary).toContain('user: q2');
    expect(ctx.summary).not.toContain('q3');
  });

  it('handles tailCount=0 by treating the whole transcript as summary', () => {
    const s = new Session('x');
    s.recordTurn('user', 'q');
    expect(s.buildSeedContext(0)).toEqual({ summary: '', replay: [] });
  });
});
