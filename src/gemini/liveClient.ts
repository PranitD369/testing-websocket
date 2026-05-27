import { WebSocket as WsWebSocket } from 'ws';
import type { LiveSetup, ServerMessage } from './liveTypes.js';
import { NativeHeartbeat } from '../reliability/heartbeat.js';
import { logger } from '../util/logger.js';
import type { Config } from '../config.js';

const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export interface LiveClientOptions {
  config: Config;
  sessionId: string;
  resumptionHandle?: string;
  systemInstruction?: string;
  onMessage: (msg: ServerMessage, raw: Buffer | string) => void;
  onClose: (code: number, reason: string) => void;
  onOpen: () => void;
  onError: (err: Error) => void;
}

/**
 * Wraps a single WS connection to Gemini Live with:
 *  - Setup message with optional `sessionResumption.handle`
 *  - Native ping/pong heartbeat
 *  - Message parsing into discriminated union
 *
 * Reconnection / replacement-on-goAway is the responsibility of the caller (see `reliability/reconnect.ts`).
 */
export class LiveClient {
  private ws: WsWebSocket | null = null;
  private heartbeat: NativeHeartbeat | null = null;
  private setupAcked = false;
  private closed = false;

  constructor(private readonly opts: LiveClientOptions) {}

  connect(): void {
    const url = `${LIVE_URL}?key=${this.opts.config.GEMINI_API_KEY}`;
    logger.info({ sessionId: this.opts.sessionId, hasHandle: !!this.opts.resumptionHandle }, 'gemini.connect');

    this.ws = new WsWebSocket(url);

    this.ws.on('open', () => {
      this.sendSetup();
      this.startHeartbeat();
      this.opts.onOpen();
    });

    this.ws.on('message', (data) => {
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        const parsed = JSON.parse(text) as ServerMessage;
        if ('setupComplete' in parsed) {
          this.setupAcked = true;
          logger.debug({ sessionId: this.opts.sessionId }, 'gemini.setupComplete');
        }
        this.opts.onMessage(parsed, data as Buffer);
      } catch (err) {
        logger.warn({ err }, 'gemini.message.parse-failed');
      }
    });

    this.ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf.toString('utf8');
      this.cleanup();
      if (!this.closed) {
        logger.info({ sessionId: this.opts.sessionId, code, reason }, 'gemini.close');
        this.opts.onClose(code, reason);
      }
    });

    this.ws.on('error', (err) => {
      logger.warn({ sessionId: this.opts.sessionId, err: err.message }, 'gemini.error');
      this.opts.onError(err);
    });
  }

  private sendSetup(): void {
    if (!this.ws) return;
    // Some Live-capable models (notably the gemini-2.5-flash-native-audio family) do not
    // support sessionResumption or contextWindowCompression and will respond with
    // close code 1011 ("Internal error encountered.") on the first turn. Gate them
    // behind env flags so the lab works out-of-the-box on the native-audio model.
    const setupInner: NonNullable<LiveSetup>['setup'] = {
      model: `models/${this.opts.config.GEMINI_LIVE_MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
      },
      // Automatic voice activity detection - Gemini infers turn boundaries from
      // silence in the audio stream. This is the default; we make it explicit
      // so it's easy to swap to manual VAD via `automaticActivityDetection.disabled`.
    };
    if (this.opts.config.ENABLE_SESSION_RESUMPTION) {
      setupInner.sessionResumption = this.opts.resumptionHandle
        ? { handle: this.opts.resumptionHandle }
        : {};
    }
    if (this.opts.config.ENABLE_CONTEXT_COMPRESSION) {
      setupInner.contextWindowCompression = {
        slidingWindow: {},
        triggerTokens: this.opts.config.CONTEXT_COMPRESS_TRIGGER_TOKENS,
      };
    }
    if (this.opts.systemInstruction) {
      setupInner.systemInstruction = { parts: [{ text: this.opts.systemInstruction }] };
    }
    this.ws.send(JSON.stringify({ setup: setupInner }));
  }

  private startHeartbeat(): void {
    if (!this.ws) return;
    this.heartbeat = new NativeHeartbeat(this.ws, {
      intervalMs: this.opts.config.HEARTBEAT_INTERVAL_MS,
      timeoutMs: this.opts.config.HEARTBEAT_TIMEOUT_MS,
      onTimeout: () => {
        logger.warn({ sessionId: this.opts.sessionId }, 'gemini.heartbeat-timeout.terminate');
        this.ws?.terminate();
      },
    });
    this.heartbeat.start();
  }

  /** Forward a JSON object (e.g. realtimeInput) upstream. Returns false if not ready. */
  send(payload: object): boolean {
    if (!this.ws || this.ws.readyState !== WsWebSocket.OPEN || !this.setupAcked) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      logger.warn({ err }, 'gemini.send-failed');
      return false;
    }
  }

  isReady(): boolean {
    return !!this.ws && this.ws.readyState === WsWebSocket.OPEN && this.setupAcked;
  }

  close(code = 1000, reason = 'client-closed'): void {
    this.closed = true;
    this.cleanup();
    if (this.ws && this.ws.readyState === WsWebSocket.OPEN) {
      this.ws.close(code, reason);
    }
  }

  private cleanup(): void {
    this.heartbeat?.stop();
    this.heartbeat = null;
  }
}
