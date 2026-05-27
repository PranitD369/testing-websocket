import type { Mode } from '../gemini/liveTypes.js';

export interface Turn {
  role: 'user' | 'model';
  text: string;
  at: number;
}

export interface Metrics {
  rttEwmaMs: number;
  pongMissCount: number;
  frameAckLagMs: number;
  lastClientPingAt: number;
  lastClientPongAt: number;
}

export class Session {
  readonly id: string;
  readonly createdAt: number;
  lastActivity: number;
  resumptionHandle?: string;
  transcript: Turn[] = [];
  mode: Mode = 'HD_VIDEO';
  metrics: Metrics = {
    rttEwmaMs: 0,
    pongMissCount: 0,
    frameAckLagMs: 0,
    lastClientPingAt: 0,
    lastClientPongAt: 0,
  };

  constructor(id: string) {
    this.id = id;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  recordTurn(role: 'user' | 'model', text: string): void {
    if (!text.trim()) return;
    this.transcript.push({ role, text, at: Date.now() });
    if (this.transcript.length > 200) this.transcript.shift();
  }

  /** Summary of the conversation to inject as systemInstruction when resuming with photo fallback. */
  transcriptSummary(maxTurns = 20): string {
    if (this.transcript.length === 0) return '';
    const recent = this.transcript.slice(-maxTurns);
    return recent.map((t) => `${t.role}: ${t.text}`).join('\n');
  }
}
