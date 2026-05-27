import { describe, it, expect } from 'vitest';
import { SessionManager } from '../src/session/SessionManager.js';

describe('SessionManager', () => {
  it('returns the same session when called twice with same id', () => {
    const sm = new SessionManager(24);
    const a = sm.getOrCreate('s1');
    const b = sm.getOrCreate('s1');
    expect(a).toBe(b);
    sm.stop();
  });

  it('mints a new id when none provided', () => {
    const sm = new SessionManager(24);
    const a = sm.getOrCreate();
    const b = sm.getOrCreate();
    expect(a.id).not.toBe(b.id);
    sm.stop();
  });

  it('persists resumption handle across re-fetch', () => {
    const sm = new SessionManager(24);
    const s = sm.getOrCreate('s1');
    s.resumptionHandle = 'h-1';
    const again = sm.getOrCreate('s1');
    expect(again.resumptionHandle).toBe('h-1');
    sm.stop();
  });

  it('records turns and produces a summary', () => {
    const sm = new SessionManager(24);
    const s = sm.getOrCreate('s1');
    s.recordTurn('user', 'what is this part?');
    s.recordTurn('model', 'it is a capacitor');
    const summary = s.transcriptSummary();
    expect(summary).toContain('user: what is this part?');
    expect(summary).toContain('model: it is a capacitor');
    sm.stop();
  });
});
