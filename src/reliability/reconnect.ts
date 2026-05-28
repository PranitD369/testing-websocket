import { LiveClient, type LiveClientOptions } from '../gemini/liveClient.js';
import type { Session } from '../session/Session.js';
import type { Summarizer } from '../session/summarizer.js';
import type { ServerMessage } from '../gemini/liveTypes.js';
import { logger } from '../util/logger.js';
import type { Config } from '../config.js';

export interface UpstreamSupervisorOptions {
  config: Config;
  session: Session;
  summarizer: Summarizer;
  /** Called for every Gemini message after upstream is ready. */
  onMessage: (msg: ServerMessage, raw: Buffer | string) => void;
  /** Called when supervisor gives up (max attempts exhausted). */
  onGiveUp: () => void;
  /** Called when an upstream is connected and `setupComplete` received. */
  onReady: () => void;
}

/**
 * Owns the Gemini upstream connection for a single client session.
 *
 *  - Holds the current LiveClient.
 *  - Persists `sessionResumptionUpdate.newHandle` onto the Session.
 *  - On `goAway`: opens a replacement LiveClient with the latest handle and swaps when ready (zero perceived gap).
 *  - On unexpected close: reconnects with jittered exponential backoff.
 */
export class UpstreamSupervisor {
  private current: LiveClient | null = null;
  private replacement: LiveClient | null = null;
  private attempts = 0;
  private stopped = false;
  private backoffTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: UpstreamSupervisorOptions) {}

  start(): void {
    void this.openCurrent();
  }

  /** Send a payload upstream (drops silently if not ready). */
  send(payload: object): boolean {
    if (!this.current) return false;
    return this.current.send(payload);
  }

  isReady(): boolean {
    return this.current?.isReady() ?? false;
  }

  stop(): void {
    this.stopped = true;
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    this.current?.close();
    this.replacement?.close();
    this.current = null;
    this.replacement = null;
  }

  private async buildLiveOpts(extra: Partial<LiveClientOptions>): Promise<LiveClientOptions> {
    const seed = await this.opts.session.buildSeedContext(
      this.opts.config.CONTEXT_REPLAY_TAIL_TURNS,
      this.opts.summarizer,
    );
    if (seed.summary || seed.replay.length > 0) {
      logger.info(
        {
          sessionId: this.opts.session.id,
          summaryChars: seed.summary.length,
          replayTurns: seed.replay.length,
        },
        'upstream.seed.prepared',
      );
    }
    return {
      config: this.opts.config,
      sessionId: this.opts.session.id,
      resumptionHandle: this.opts.session.resumptionHandle,
      systemInstruction: seed.summary || undefined,
      replayTurns: seed.replay.length > 0 ? seed.replay : undefined,
      onMessage: (msg, raw) => this.handleMessage(msg, raw),
      onClose: (code, reason) => this.handleClose(code, reason),
      onOpen: () => {},
      onError: () => {},
      ...extra,
    };
  }

  private async openCurrent(): Promise<void> {
    if (this.stopped) return;
    this.attempts += 1;
    try {
      const liveOpts = await this.buildLiveOpts({
        onOpen: () => {
          logger.info({ sessionId: this.opts.session.id, attempts: this.attempts }, 'upstream.open');
        },
      });
      if (this.stopped) return;
      const lc = new LiveClient(liveOpts);
      this.current = lc;
      lc.connect();
    } catch (err) {
      logger.error(
        { sessionId: this.opts.session.id, err: (err as Error).message },
        'upstream.open.failed',
      );
      this.handleClose(0, 'open-failed');
    }
  }

  /** Proactively open a replacement upstream (on goAway) and swap once it's ready. */
  private async openReplacement(): Promise<void> {
    if (this.stopped || this.replacement) return;
    logger.info({ sessionId: this.opts.session.id }, 'upstream.replacement.opening');
    let repl: LiveClient | null = null;
    try {
      const liveOpts = await this.buildLiveOpts({
        onOpen: () => {},
        onMessage: (msg, raw) => {
          if ('setupComplete' in msg) {
            logger.info({ sessionId: this.opts.session.id }, 'upstream.replacement.ready.swap');
            const old = this.current;
            if (repl) this.current = repl;
            this.replacement = null;
            old?.close(1000, 'replaced');
            this.opts.onReady();
            return;
          }
          this.handleMessage(msg, raw);
        },
        onClose: (code, reason) => {
          if (repl && this.replacement === repl) {
            logger.warn({ code, reason }, 'upstream.replacement.closed-before-swap');
            this.replacement = null;
          }
        },
      });
      if (this.stopped) return;
      repl = new LiveClient(liveOpts);
      this.replacement = repl;
      repl.connect();
    } catch (err) {
      logger.warn(
        { sessionId: this.opts.session.id, err: (err as Error).message },
        'upstream.replacement.open.failed',
      );
    }
  }

  private handleMessage(msg: ServerMessage, raw: Buffer | string): void {
    if ('setupComplete' in msg) {
      this.attempts = 0;
      this.opts.onReady();
    } else if ('sessionResumptionUpdate' in msg) {
      const { newHandle, resumable } = msg.sessionResumptionUpdate;
      if (newHandle && resumable !== false) {
        this.opts.session.setResumptionHandle(newHandle);
        logger.debug({ sessionId: this.opts.session.id }, 'upstream.handle.updated');
      }
    } else if ('goAway' in msg) {
      logger.info(
        { sessionId: this.opts.session.id, timeLeft: msg.goAway.timeLeft },
        'upstream.goAway',
      );
      void this.openReplacement();
    }
    this.opts.onMessage(msg, raw);
  }

  private handleClose(code: number, reason: string): void {
    this.current = null;
    if (this.stopped) return;
    if (this.attempts >= this.opts.config.MAX_RECONNECT_ATTEMPTS) {
      logger.error({ attempts: this.attempts }, 'upstream.giveup');
      this.opts.onGiveUp();
      return;
    }
    const delay = this.backoffMs();
    logger.info({ code, reason, delay, nextAttempt: this.attempts + 1 }, 'upstream.reconnect.scheduled');
    this.backoffTimer = setTimeout(() => void this.openCurrent(), delay);
    this.backoffTimer.unref?.();
  }

  private backoffMs(): number {
    const base = Math.min(250 * Math.pow(2, this.attempts), 30_000);
    const jitter = Math.random() * 0.3 * base;
    return Math.round(base + jitter);
  }
}
