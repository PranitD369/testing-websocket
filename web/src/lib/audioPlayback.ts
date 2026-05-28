import { base64ToBytes } from './base64.js';

/**
 * Plays 24kHz 16-bit LE PCM chunks from Gemini Live in-order. Each chunk is scheduled
 * to start exactly when the previous one ends to avoid gaps and overlapping playback.
 * Call `interrupt()` on barge-in or session close.
 */
export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private nextStart = 0;
  private sources: AudioBufferSourceNode[] = [];

  play(base64: string): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.nextStart = 0;
    }
    const bytes = base64ToBytes(base64);
    if (bytes.length < 2) return;
    const aligned = new Uint8Array(bytes.length);
    aligned.set(bytes);
    const samples = new Int16Array(
      aligned.buffer,
      aligned.byteOffset,
      Math.floor(aligned.byteLength / 2),
    );
    const float = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) float[i] = samples[i]! / 32768;

    const buf = this.ctx.createBuffer(1, float.length, 24000);
    buf.copyToChannel(float, 0);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    const startAt = Math.max(this.nextStart, now + 0.02);
    src.start(startAt);
    this.nextStart = startAt + buf.duration;
    this.sources.push(src);
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src);
    };
  }

  interrupt(): void {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        /* may have already ended */
      }
    }
    this.sources = [];
    this.nextStart = 0;
  }

  close(): void {
    this.interrupt();
    void this.ctx?.close();
    this.ctx = null;
  }
}
