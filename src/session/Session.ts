import type { Mode } from '../gemini/liveTypes.js';
import type { Summarizer } from './summarizer.js';
import { logger } from '../util/logger.js';

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
  onSummaryChange?: (text: string, upToCount: number) => void;
}

export interface SeedContext {
  summary: string;
  replay: Turn[];
}

export interface SummaryCache {
  text: string;
  upToCount: number;
}

function rawConcat(turns: Turn[]): string {
  return 'Earlier conversation summary:\n' + turns.map((t) => `${t.role}: ${t.text}`).join('\n');
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
  summaryCache?: SummaryCache;
  private summaryInFlight: Promise<string> | null = null;
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

  setSummary(text: string, upToCount: number): void {
    this.summaryCache = { text, upToCount };
    this.hooks.onSummaryChange?.(text, upToCount);
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
   * - `summary`: every turn older than the tail, compressed by the LLM. Cached on the
   *   Session and persisted; reused on subsequent reconnects until new older turns accrue.
   * - `replay`: the most recent `tailCount` turns, sent as a clientContent batch right
   *   after setupComplete so the model has live working context.
   * If the summarizer throws or times out, falls back to a raw `role: text` concat so
   * reconnect is never blocked indefinitely.
   */
  async buildSeedContext(tailCount: number, summarizer: Summarizer): Promise<SeedContext> {
    if (tailCount <= 0 || this.transcript.length === 0) {
      return { summary: '', replay: [] };
    }
    if (this.transcript.length <= tailCount) {
      return { summary: '', replay: [...this.transcript] };
    }
    const olderCount = this.transcript.length - tailCount;
    const older = this.transcript.slice(0, olderCount);
    const replay = this.transcript.slice(olderCount);

    if (this.summaryCache && this.summaryCache.upToCount === olderCount) {
      logger.info(
        { sessionId: this.id, upToCount: olderCount },
        'summary.cache.hit',
      );
      return { summary: this.summaryCache.text, replay };
    }

    // Dedupe concurrent reconnects on the same session.
    if (this.summaryInFlight) {
      try {
        const text = await this.summaryInFlight;
        return { summary: text, replay };
      } catch {
        // Fall through to raw concat below.
      }
    }

    const started = Date.now();
    logger.info({ sessionId: this.id, older: olderCount }, 'summary.compute.start');
    this.summaryInFlight = summarizer.summarize(older);
    try {
      const text = await this.summaryInFlight;
      this.setSummary(text, olderCount);
      logger.info(
        { sessionId: this.id, chars: text.length, latencyMs: Date.now() - started },
        'summary.compute.ok',
      );
      return { summary: text, replay };
    } catch (err) {
      const message = (err as Error).message;
      const latencyMs = Date.now() - started;
      if (message === 'summary-timeout') {
        logger.warn(
          { sessionId: this.id, latencyMs, fallback: 'raw-concat' },
          'summary.compute.timeout',
        );
      } else {
        logger.warn({ sessionId: this.id, err: message, latencyMs }, 'summary.compute.failed');
      }
      return { summary: rawConcat(older), replay };
    } finally {
      this.summaryInFlight = null;
    }
  }
}
