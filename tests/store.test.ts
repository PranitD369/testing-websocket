import { describe, it, expect } from 'vitest';
import { MemorySessionStore } from '../src/session/memoryStore.js';
import { Session } from '../src/session/Session.js';

describe('MemorySessionStore', () => {
  it('round-trips a session with transcript', async () => {
    const store = new MemorySessionStore();
    const s = new Session('abc');
    s.recordTurn('user', 'hello');
    s.recordTurn('model', 'hi');
    s.setResumptionHandle('h1');
    await store.save(s);
    // The Session.recordTurn calls happened before save() so they aren't in the snapshot
    // by themselves — save() copies the live transcript array, which is what we want.
    const snap = await store.load('abc');
    expect(snap).not.toBeNull();
    expect(snap?.transcript).toHaveLength(2);
    expect(snap?.transcript[0]?.text).toBe('hello');
    expect(snap?.resumptionHandle).toBe('h1');
  });

  it('appendTurn adds to existing snapshot', async () => {
    const store = new MemorySessionStore();
    const s = new Session('abc');
    await store.save(s);
    await store.appendTurn('abc', { role: 'user', text: 'q1', at: 1 });
    await store.appendTurn('abc', { role: 'model', text: 'a1', at: 2 });
    const snap = await store.load('abc');
    expect(snap?.transcript).toHaveLength(2);
    expect(snap?.transcript[1]?.text).toBe('a1');
  });

  it('saveHandle updates the resumption handle', async () => {
    const store = new MemorySessionStore();
    await store.save(new Session('abc'));
    await store.saveHandle('abc', 'h-new');
    const snap = await store.load('abc');
    expect(snap?.resumptionHandle).toBe('h-new');
  });

  it('removeExpired drops entries older than cutoff', async () => {
    const store = new MemorySessionStore();
    const s1 = new Session('old', 100);
    s1.lastActivity = 100;
    const s2 = new Session('new', 1_000_000);
    s2.lastActivity = 1_000_000;
    await store.save(s1);
    await store.save(s2);
    const removed = await store.removeExpired(500);
    expect(removed).toBe(1);
    expect(await store.load('old')).toBeNull();
    expect(await store.load('new')).not.toBeNull();
  });

  it('returns null for unknown id', async () => {
    const store = new MemorySessionStore();
    expect(await store.load('missing')).toBeNull();
  });
});
