/**
 * Tracks signals that indicate connection quality:
 *  - RTT exponentially-weighted moving average (EWMA)
 *  - Pong-miss count (consecutive)
 *  - Frame-ack lag (server send -> client ack delta) EWMA
 *
 * Exposes a single `qualityScore()` derived value for `degradation.ts` to make mode decisions.
 */

export interface Sample {
  rttMs: number;
  at: number;
}

export class BandwidthMonitor {
  private rttEwma = 0;
  private frameLagEwma = 0;
  private pongMisses = 0;
  private readonly alpha = 0.3;

  recordRtt(rttMs: number): void {
    this.rttEwma = this.rttEwma === 0 ? rttMs : this.alpha * rttMs + (1 - this.alpha) * this.rttEwma;
    this.pongMisses = 0;
  }

  recordPongMiss(): void {
    this.pongMisses += 1;
  }

  recordFrameAckLag(lagMs: number): void {
    this.frameLagEwma =
      this.frameLagEwma === 0 ? lagMs : this.alpha * lagMs + (1 - this.alpha) * this.frameLagEwma;
  }

  get rtt(): number {
    return this.rttEwma;
  }

  get misses(): number {
    return this.pongMisses;
  }

  get frameLag(): number {
    return this.frameLagEwma;
  }

  reset(): void {
    this.rttEwma = 0;
    this.frameLagEwma = 0;
    this.pongMisses = 0;
  }

  snapshot(): { rttMs: number; misses: number; frameLagMs: number } {
    return { rttMs: Math.round(this.rttEwma), misses: this.pongMisses, frameLagMs: Math.round(this.frameLagEwma) };
  }
}
