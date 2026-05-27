import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BandwidthMonitor } from '../src/reliability/bandwidthMonitor.js';
import { DegradationController } from '../src/reliability/degradation.js';

const thresholds = { ldRttMs: 200, audioRttMs: 500, photoRttMs: 1500 };

describe('DegradationController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts in HD_VIDEO', () => {
    const monitor = new BandwidthMonitor();
    const d = new DegradationController(monitor, { thresholds });
    expect(d.mode).toBe('HD_VIDEO');
  });

  it('downgrades immediately as RTT rises', () => {
    const monitor = new BandwidthMonitor();
    const changes: string[] = [];
    const d = new DegradationController(monitor, { thresholds, onChange: (m) => changes.push(m) });

    for (let i = 0; i < 10; i++) monitor.recordRtt(300); // > 200, < 500
    d.evaluate();
    expect(d.mode).toBe('LD_VIDEO');

    for (let i = 0; i < 10; i++) monitor.recordRtt(800); // > 500
    d.evaluate();
    expect(d.mode).toBe('AUDIO_ONLY');

    for (let i = 0; i < 10; i++) monitor.recordRtt(2000); // > 1500
    d.evaluate();
    expect(d.mode).toBe('PHOTO_MODE');

    expect(changes).toEqual(['LD_VIDEO', 'AUDIO_ONLY', 'PHOTO_MODE']);
  });

  it('holds down upgrades until conditions are sustained 5s', () => {
    const monitor = new BandwidthMonitor();
    const d = new DegradationController(monitor, { thresholds });

    // Get to AUDIO_ONLY first.
    for (let i = 0; i < 10; i++) monitor.recordRtt(800);
    d.evaluate();
    expect(d.mode).toBe('AUDIO_ONLY');

    // Now drop RTT to good range, but evaluate before 5s passes.
    monitor.reset();
    for (let i = 0; i < 10; i++) monitor.recordRtt(50);
    d.evaluate();
    expect(d.mode).toBe('AUDIO_ONLY'); // still held

    vi.advanceTimersByTime(4000);
    d.evaluate();
    expect(d.mode).toBe('AUDIO_ONLY');

    vi.advanceTimersByTime(1100);
    d.evaluate();
    expect(d.mode).toBe('HD_VIDEO');
  });

  it('forceMode bypasses hysteresis', () => {
    const monitor = new BandwidthMonitor();
    const d = new DegradationController(monitor, { thresholds });
    d.forceMode('PHOTO_MODE');
    expect(d.mode).toBe('PHOTO_MODE');
  });

  it('shouldForwardVideo gates correctly', () => {
    const monitor = new BandwidthMonitor();
    const d = new DegradationController(monitor, { thresholds });
    expect(d.shouldForwardVideo()).toBe(true);
    d.forceMode('AUDIO_ONLY');
    expect(d.shouldForwardVideo()).toBe(false);
    expect(d.shouldForwardAudio()).toBe(true);
    d.forceMode('PHOTO_MODE');
    expect(d.shouldForwardAudio()).toBe(false);
  });

  it('escalates on consecutive pong misses', () => {
    const monitor = new BandwidthMonitor();
    const d = new DegradationController(monitor, { thresholds });
    monitor.recordRtt(50);
    d.evaluate();
    expect(d.mode).toBe('HD_VIDEO');

    monitor.recordPongMiss();
    d.evaluate();
    expect(d.mode).toBe('LD_VIDEO');

    monitor.recordPongMiss();
    d.evaluate();
    expect(d.mode).toBe('AUDIO_ONLY');

    monitor.recordPongMiss();
    d.evaluate();
    expect(d.mode).toBe('PHOTO_MODE');
  });
});
