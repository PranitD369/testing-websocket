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

export interface SessionHooks {
  onTurn?: (turn: Turn) => void;
  onHandleChange?: (handle: string | undefined) => void;
  onTouch?: (at: number) => void;
}

export interface SeedContext {
  summary: string;
  replay: Turn[];
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
  private hooks: SessionHooks = {};

  constructor(id: string, createdAt: number = Date.now()) {
    this.id = id;
    this.createdAt = createdAt;
    this.lastActivity = createdAt;
  }

  setHooks(hooks: SessionHooks): void {
    this.hooks = hooks;
  }

  setResumptionHandle(handle: string | undefined): void {
    if (handle === this.resumptionHandle) return;
    this.resumptionHandle = handle;
    this.hooks.onHandleChange?.(handle);
  }

  touch(): void {
    this.lastActivity = Date.now();
    this.hooks.onTouch?.(this.lastActivity);
  }

  recordTurn(role: 'user' | 'model', text: string): void {
    if (!text.trim()) return;
    const turn: Turn = { role, text, at: Date.now() };
    this.transcript.push(turn);
    if (this.transcript.length > 200) this.transcript.shift();
    this.hooks.onTurn?.(turn);
  }

  /** Summary of the conversation to inject as systemInstruction when resuming with photo fallback. */
  transcriptSummary(maxTurns = 20): string {
    if (this.transcript.length === 0) return '';
    const recent = this.transcript.slice(-maxTurns);
    return recent.map((t) => `${t.role}: ${t.text}`).join('\n');
  }

  /**
   * Hybrid context-replay seed for a fresh upstream connection.
   * - `summary`: every turn older than the tail, flattened. Sent as systemInstruction.
   * - `replay`: the most recent `tailCount` turns, sent as a clientContent batch right
   *   after setupComplete so the model has live working context.
   * Used when the model doesn't support Gemini's native `sessionResumption` mechanism.
   */
  buildSeedContext(tailCount: number): SeedContext {
    if (tailCount <= 0 || this.transcript.length === 0) {
      return { summary: '', replay: [] };
    }
    if (this.transcript.length <= tailCount) {
      return { summary: '', replay: [...this.transcript] };
    }
    const olderCount = this.transcript.length - tailCount;
    const older = this.transcript.slice(0, olderCount);
    const replay = this.transcript.slice(olderCount);
    const summary =
      'Earlier conversation summary:\n' + older.map((t) => `${t.role}: ${t.text}`).join('\n');
    return { summary, replay };
  }
}
