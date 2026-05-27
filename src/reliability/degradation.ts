import type { Mode } from '../gemini/liveTypes.js';
import type { BandwidthMonitor } from './bandwidthMonitor.js';
import { logger } from '../util/logger.js';

export interface DegradationThresholds {
  ldRttMs: number;
  audioRttMs: number;
  photoRttMs: number;
}

/** Hysteresis: require this many ms of improved metrics before upgrading mode. Prevents flapping. */
const UPGRADE_HOLDDOWN_MS = 5000;

export interface DegradationOptions {
  thresholds: DegradationThresholds;
  initialMode?: Mode;
  onChange?: (mode: Mode, prev: Mode) => void;
}

export class DegradationController {
  private current: Mode;
  private improvedSince: number | null = null;

  constructor(
    private readonly monitor: BandwidthMonitor,
    private readonly opts: DegradationOptions,
  ) {
    this.current = opts.initialMode ?? 'HD_VIDEO';
  }

  get mode(): Mode {
    return this.current;
  }

  /** Decide target mode from the current metrics (no hysteresis). */
  private targetMode(): Mode {
    const { rtt, misses } = this.monitor;
    const { ldRttMs, audioRttMs, photoRttMs } = this.opts.thresholds;

    if (rtt > photoRttMs || misses >= 3) return 'PHOTO_MODE';
    if (rtt > audioRttMs || misses >= 2) return 'AUDIO_ONLY';
    if (rtt > ldRttMs || misses >= 1) return 'LD_VIDEO';
    return 'HD_VIDEO';
  }

  /** Call periodically (e.g., on each RTT sample). Returns true if the mode changed. */
  evaluate(): boolean {
    const target = this.targetMode();
    if (target === this.current) {
      this.improvedSince = null;
      return false;
    }

    if (this.isDowngrade(this.current, target)) {
      const prev = this.current;
      this.current = target;
      this.improvedSince = null;
      logger.info({ from: prev, to: target, metrics: this.monitor.snapshot() }, 'degradation.downgrade');
      this.opts.onChange?.(target, prev);
      return true;
    }

    // Upgrade: require sustained improvement.
    if (this.improvedSince === null) this.improvedSince = Date.now();
    if (Date.now() - this.improvedSince >= UPGRADE_HOLDDOWN_MS) {
      const prev = this.current;
      this.current = target;
      this.improvedSince = null;
      logger.info({ from: prev, to: target, metrics: this.monitor.snapshot() }, 'degradation.upgrade');
      this.opts.onChange?.(target, prev);
      return true;
    }
    return false;
  }

  /** Force a mode (e.g., user manually selected photo mode). */
  forceMode(mode: Mode): void {
    if (mode === this.current) return;
    const prev = this.current;
    this.current = mode;
    this.improvedSince = null;
    logger.info({ from: prev, to: mode }, 'degradation.forced');
    this.opts.onChange?.(mode, prev);
  }

  private isDowngrade(from: Mode, to: Mode): boolean {
    const order: Record<Mode, number> = { HD_VIDEO: 0, LD_VIDEO: 1, AUDIO_ONLY: 2, PHOTO_MODE: 3 };
    return order[to] > order[from];
  }

  /** Whether the proxy should forward a video frame to upstream given current mode. */
  shouldForwardVideo(): boolean {
    return this.current === 'HD_VIDEO' || this.current === 'LD_VIDEO';
  }

  /** Whether to forward audio chunks to upstream. */
  shouldForwardAudio(): boolean {
    return this.current !== 'PHOTO_MODE';
  }

  /** Client capture hint based on current mode. */
  captureHint(): { maxFps: number; audioOnly: boolean; photoMode: boolean } {
    switch (this.current) {
      case 'HD_VIDEO':
        return { maxFps: 1, audioOnly: false, photoMode: false };
      case 'LD_VIDEO':
        return { maxFps: 0.5, audioOnly: false, photoMode: false };
      case 'AUDIO_ONLY':
        return { maxFps: 0, audioOnly: true, photoMode: false };
      case 'PHOTO_MODE':
        return { maxFps: 0, audioOnly: false, photoMode: true };
    }
  }
}
