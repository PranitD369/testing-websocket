import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from '../src/session/SessionManager.js';
import { MemorySessionStore } from '../src/session/memoryStore.js';
import { Session, type Turn } from '../src/session/Session.js';
import type { Summarizer } from '../src/session/summarizer.js';

function makeManager(): SessionManager {
  return new SessionManager(24, new MemorySessionStore());
}

function stubSummarizer(text = 'STUB SUMMARY'): { s: Summarizer; calls: Turn[][] } {
  const calls: Turn[][] = [];
  return {
    s: {
      async summarize(turns) {
        calls.push(turns);
        return text;
      },
    },
    calls,
  };
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

    const sm2 = new SessionManager(24, store);
    const s2 = await sm2.getOrCreate('s-cross');
    expect(s2.transcript).toHaveLength(2);
    expect(s2.transcript[0]?.text).toBe('before restart');
    expect(s2.resumptionHandle).toBe('handle-x');
    sm2.stop();
  });

  it('rehydrates the cached summary on reload', async () => {
    const store = new MemorySessionStore();
    const sm1 = new SessionManager(24, store);
    const s1 = await sm1.getOrCreate('s-summary');
    s1.setSummary('cached paragraph', 5);
    sm1.stop();

    const sm2 = new SessionManager(24, store);
    const s2 = await sm2.getOrCreate('s-summary');
    expect(s2.summaryCache).toEqual({ text: 'cached paragraph', upToCount: 5 });
    sm2.stop();
  });
});

describe('Session.buildSeedContext', () => {
  it('returns empty for an empty transcript', async () => {
    const { s } = stubSummarizer();
    const result = await new Session('x').buildSeedContext(3, s);
    expect(result).toEqual({ summary: '', replay: [] });
  });

  it('puts everything into replay when transcript fits in the tail', async () => {
    const sess = new Session('x');
    sess.recordTurn('user', 'q1');
    sess.recordTurn('model', 'a1');
    const { s, calls } = stubSummarizer();
    const ctx = await sess.buildSeedContext(3, s);
    expect(ctx.summary).toBe('');
    expect(ctx.replay).toHaveLength(2);
    expect(ctx.replay[0]?.text).toBe('q1');
    expect(calls).toHaveLength(0);
  });

  it('calls the summarizer for older turns and keeps the last N as replay', async () => {
    const sess = new Session('x');
    for (let i = 0; i < 12; i++) {
      sess.recordTurn(i % 2 === 0 ? 'user' : 'model', `t${i}`);
    }
    const { s, calls } = stubSummarizer('LLM summary');
    const ctx = await sess.buildSeedContext(10, s);
    expect(ctx.replay).toHaveLength(10);
    expect(ctx.replay.map((t) => t.text)).toEqual(['t2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11']);
    expect(ctx.summary).toBe('LLM summary');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(calls[0]?.map((t) => t.text)).toEqual(['t0', 't1']);
  });

  it('reuses the cached summary on a subsequent call without re-calling the summarizer', async () => {
    const sess = new Session('x');
    for (let i = 0; i < 12; i++) {
      sess.recordTurn(i % 2 === 0 ? 'user' : 'model', `t${i}`);
    }
    const { s, calls } = stubSummarizer('LLM summary');
    const a = await sess.buildSeedContext(10, s);
    const b = await sess.buildSeedContext(10, s);
    expect(a.summary).toBe('LLM summary');
    expect(b.summary).toBe('LLM summary');
    expect(calls).toHaveLength(1);
  });

  it('re-summarizes when older has grown past the cached upToCount', async () => {
    const sess = new Session('x');
    for (let i = 0; i < 12; i++) {
      sess.recordTurn(i % 2 === 0 ? 'user' : 'model', `t${i}`);
    }
    const summary = vi.fn(async () => 'v1');
    await sess.buildSeedContext(10, { summarize: summary });
    expect(summary).toHaveBeenCalledTimes(1);

    // Two more turns -> older grows from 2 to 4 -> cache stale.
    sess.recordTurn('user', 'tA');
    sess.recordTurn('model', 'tB');
    const summary2 = vi.fn(async () => 'v2');
    const ctx = await sess.buildSeedContext(10, { summarize: summary2 });
    expect(summary2).toHaveBeenCalledTimes(1);
    expect(ctx.summary).toBe('v2');
    expect(sess.summaryCache?.upToCount).toBe(4);
  });

  it('falls back to raw concat when the summarizer throws', async () => {
    const sess = new Session('x');
    for (let i = 0; i < 12; i++) {
      sess.recordTurn(i % 2 === 0 ? 'user' : 'model', `older${i}`);
    }
    const fail: Summarizer = {
      async summarize() {
        throw new Error('boom');
      },
    };
    const ctx = await sess.buildSeedContext(10, fail);
    expect(ctx.replay).toHaveLength(10);
    expect(ctx.summary).toContain('Earlier conversation summary:');
    expect(ctx.summary).toContain('user: older0');
    // No cache after failure; next call retries.
    expect(sess.summaryCache).toBeUndefined();
  });

  it('handles tailCount=0 by returning no seed', async () => {
    const sess = new Session('x');
    sess.recordTurn('user', 'q');
    const { s } = stubSummarizer();
    expect(await sess.buildSeedContext(0, s)).toEqual({ summary: '', replay: [] });
  });

  it('dedupes concurrent reconnects on the same session', async () => {
    const sess = new Session('x');
    for (let i = 0; i < 12; i++) {
      sess.recordTurn(i % 2 === 0 ? 'user' : 'model', `t${i}`);
    }
    let calls = 0;
    const slow: Summarizer = {
      summarize: () =>
        new Promise((resolve) => {
          calls++;
          setTimeout(() => resolve('shared'), 20);
        }),
    };
    const [a, b] = await Promise.all([
      sess.buildSeedContext(10, slow),
      sess.buildSeedContext(10, slow),
    ]);
    expect(a.summary).toBe('shared');
    expect(b.summary).toBe('shared');
    expect(calls).toBe(1);
  });
});
