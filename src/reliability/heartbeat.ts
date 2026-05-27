import type { WebSocket as WsWebSocket } from 'ws';
import { logger } from '../util/logger.js';

export interface HeartbeatOptions {
  intervalMs: number;
  timeoutMs: number;
  onTimeout: () => void;
  onRtt?: (rttMs: number) => void;
}

/**
 * Application-level heartbeat for browser clients (browser WebSocket cannot send native ping frames).
 *
 * Sends `{type:"ping",t}` periodically; expects `{type:"pong",t}` echo. Calculates RTT and triggers
 * `onTimeout` if no pong returns within `timeoutMs`.
 */
export class AppHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private lastPongAt = Date.now();
  private stopped = false;

  constructor(
    private readonly ws: { send: (data: string) => void; readyState: number },
    private readonly opts: HeartbeatOptions,
  ) {}

  start(): void {
    this.lastPongAt = Date.now();
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  /** Call when a `{type:"pong",t}` arrives from the peer. */
  handlePong(t: number): void {
    const rtt = Date.now() - t;
    this.lastPongAt = Date.now();
    this.opts.onRtt?.(rtt);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.stopped) return;
    const now = Date.now();
    if (now - this.lastPongAt > this.opts.timeoutMs) {
      logger.warn({ silentFor: now - this.lastPongAt }, 'heartbeat.timeout');
      this.stop();
      this.opts.onTimeout();
      return;
    }
    if (this.ws.readyState === 1 /* OPEN */) {
      try {
        this.ws.send(JSON.stringify({ type: 'ping', t: now }));
      } catch (err) {
        logger.warn({ err }, 'heartbeat.send-failed');
      }
    }
  }
}

/**
 * Native ping/pong heartbeat for server<->Gemini WS leg (no browser involved).
 * Uses the `ws` library's `ping()`/`pong` frames and `pong` event.
 */
export class NativeHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private lastPongAt = Date.now();
  private stopped = false;

  constructor(
    private readonly ws: WsWebSocket,
    private readonly opts: HeartbeatOptions,
  ) {}

  start(): void {
    this.lastPongAt = Date.now();
    this.ws.on('pong', () => {
      this.lastPongAt = Date.now();
    });
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.stopped) return;
    if (Date.now() - this.lastPongAt > this.opts.timeoutMs) {
      logger.warn({ silentFor: Date.now() - this.lastPongAt }, 'heartbeat.upstream.timeout');
      this.stop();
      this.opts.onTimeout();
      return;
    }
    try {
      this.ws.ping();
    } catch (err) {
      logger.warn({ err }, 'heartbeat.upstream.ping-failed');
    }
  }
}
