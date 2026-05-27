import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppHeartbeat } from '../src/reliability/heartbeat.js';

class FakeWs {
  readyState = 1;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

describe('AppHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends pings on the configured interval', () => {
    const ws = new FakeWs();
    const hb = new AppHeartbeat(ws, { intervalMs: 100, timeoutMs: 5000, onTimeout: () => {} });
    hb.start();

    vi.advanceTimersByTime(350);
    expect(ws.sent.length).toBe(3);
    for (const s of ws.sent) expect(JSON.parse(s).type).toBe('ping');
    hb.stop();
  });

  it('triggers onTimeout when pongs stop coming', () => {
    const ws = new FakeWs();
    const onTimeout = vi.fn();
    const hb = new AppHeartbeat(ws, { intervalMs: 50, timeoutMs: 200, onTimeout });
    hb.start();

    // Simulate a pong right at start to seed lastPongAt.
    hb.handlePong(Date.now());

    // No pongs after this; should fire onTimeout once after >200ms.
    vi.advanceTimersByTime(500);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('reports RTT from handlePong', () => {
    const ws = new FakeWs();
    const rtts: number[] = [];
    const hb = new AppHeartbeat(ws, {
      intervalMs: 100,
      timeoutMs: 5000,
      onTimeout: () => {},
      onRtt: (r) => rtts.push(r),
    });
    hb.start();

    const sentAt = Date.now();
    vi.advanceTimersByTime(50); // 50ms "network"
    hb.handlePong(sentAt);
    expect(rtts.length).toBe(1);
    expect(rtts[0]).toBeGreaterThanOrEqual(50);
    hb.stop();
  });

  it('stops sending after stop()', () => {
    const ws = new FakeWs();
    const hb = new AppHeartbeat(ws, { intervalMs: 50, timeoutMs: 5000, onTimeout: () => {} });
    hb.start();
    vi.advanceTimersByTime(120);
    const countBefore = ws.sent.length;
    hb.stop();
    vi.advanceTimersByTime(500);
    expect(ws.sent.length).toBe(countBefore);
  });
});
