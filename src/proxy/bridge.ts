import type { WebSocket } from 'ws';
import { UpstreamSupervisor } from '../reliability/reconnect.js';
import { AppHeartbeat } from '../reliability/heartbeat.js';
import { BandwidthMonitor } from '../reliability/bandwidthMonitor.js';
import { DegradationController } from '../reliability/degradation.js';
import type { Session } from '../session/Session.js';
import type { Config } from '../config.js';
import type { ServerMessage } from '../gemini/liveTypes.js';
import { logger } from '../util/logger.js';

export interface BridgeOptions {
  config: Config;
  session: Session;
  clientWs: WebSocket;
  /** Optional debug toggles via query params (?inject=...) */
  inject?: Set<string>;
}

interface ClientMessage {
  type: string;
  [k: string]: unknown;
}

/**
 * Wires a single client WebSocket <-> Gemini Live (via UpstreamSupervisor).
 *
 * Responsibilities:
 *  - App-level heartbeat with the client (browsers can't send native pings)
 *  - Receive client realtimeInput / clientContent / frameAck / forceMode / pong
 *  - Apply degradation rules to filter outbound (server-enforced)
 *  - Forward Gemini serverContent / audio chunks to the client
 *  - Persist transcript turns onto the Session for resumption / fallback context
 */
export class Bridge {
  private readonly monitor = new BandwidthMonitor();
  private readonly degradation: DegradationController;
  private upstream: UpstreamSupervisor | null = null;
  private clientHeartbeat: AppHeartbeat | null = null;
  private readonly inFlightFrames = new Map<string, number>();
  private pendingUserTurn = '';
  private pendingModelTurn = '';
  private closed = false;

  constructor(private readonly opts: BridgeOptions) {
    this.degradation = new DegradationController(this.monitor, {
      thresholds: {
        ldRttMs: opts.config.DEGRADATION_RTT_LD_MS,
        audioRttMs: opts.config.DEGRADATION_RTT_AUDIO_MS,
        photoRttMs: opts.config.DEGRADATION_RTT_PHOTO_MS,
      },
      initialMode: opts.session.mode,
      onChange: (mode) => {
        opts.session.mode = mode;
        this.sendClient({ type: 'modeChange', mode, capture: this.degradation.captureHint() });
      },
    });
  }

  start(): void {
    this.startClientHeartbeat();
    this.startUpstream();

    // Tell the client what session it has and the initial mode.
    this.sendClient({
      type: 'hello',
      sessionId: this.opts.session.id,
      mode: this.degradation.mode,
      capture: this.degradation.captureHint(),
      resuming: !!this.opts.session.resumptionHandle,
    });

    this.opts.clientWs.on('message', (data) => this.handleClientMessage(data));
    this.opts.clientWs.on('close', (code, reason) => {
      logger.info({ sessionId: this.opts.session.id, code, reason: reason.toString() }, 'bridge.client.close');
      this.shutdown();
    });
    this.opts.clientWs.on('error', (err) => {
      logger.warn({ sessionId: this.opts.session.id, err: err.message }, 'bridge.client.error');
    });
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.clientHeartbeat?.stop();
    this.upstream?.stop();
    this.upstream = null;
  }

  private startClientHeartbeat(): void {
    this.clientHeartbeat = new AppHeartbeat(this.opts.clientWs, {
      intervalMs: this.opts.config.HEARTBEAT_INTERVAL_MS,
      timeoutMs: this.opts.config.HEARTBEAT_TIMEOUT_MS,
      onTimeout: () => {
        logger.warn({ sessionId: this.opts.session.id }, 'bridge.client.heartbeat-timeout');
        try {
          this.opts.clientWs.close(4000, 'heartbeat-timeout');
        } catch {
          /* noop */
        }
      },
      onRtt: (rttMs) => {
        if (this.opts.inject?.has('stallPongs')) return;
        this.monitor.recordRtt(rttMs);
        this.opts.session.metrics.rttEwmaMs = this.monitor.rtt;
        this.degradation.evaluate();
      },
    });
    this.clientHeartbeat.start();
  }

  private startUpstream(): void {
    this.upstream = new UpstreamSupervisor({
      config: this.opts.config,
      session: this.opts.session,
      onMessage: (msg, raw) => this.handleUpstreamMessage(msg, raw),
      onReady: () => {
        this.sendClient({ type: 'upstreamReady' });
      },
      onGiveUp: () => {
        logger.error({ sessionId: this.opts.session.id }, 'bridge.upstream.giveup.fallback-to-photo');
        this.degradation.forceMode('PHOTO_MODE');
        this.sendClient({ type: 'upstreamGaveUp', message: 'Switch to photo mode.' });
      },
    });
    this.upstream.start();
  }

  private handleClientMessage(data: unknown): void {
    let msg: ClientMessage;
    try {
      const text = data instanceof Buffer ? data.toString('utf8') : String(data);
      msg = JSON.parse(text);
    } catch {
      return;
    }
    this.opts.session.touch();

    switch (msg.type) {
      case 'pong':
        if (typeof msg.t === 'number') this.clientHeartbeat?.handlePong(msg.t);
        return;
      case 'frameAck':
        if (typeof msg.id === 'string') this.recordFrameAck(msg.id);
        return;
      case 'forceMode':
        if (typeof msg.mode === 'string') this.degradation.forceMode(msg.mode as never);
        return;
      case 'realtimeInput': {
        const payload = msg.payload as Record<string, unknown> | undefined;
        if (!payload) return;
        this.handleRealtimeInput(payload);
        return;
      }
      case 'clientContent': {
        const payload = msg.payload as Record<string, unknown> | undefined;
        if (!payload) return;
        this.captureUserTurnFromClientContent(payload);
        this.upstream?.send({ clientContent: payload });
        return;
      }
      default:
        logger.debug({ type: msg.type }, 'bridge.client.unknown-type');
    }
  }

  private handleRealtimeInput(payload: Record<string, unknown>): void {
    // Mark frame as in-flight if it has a frameId (client-supplied).
    const meta = payload.__meta as { frameId?: string } | undefined;
    if (meta?.frameId) this.inFlightFrames.set(meta.frameId, Date.now());

    // Server-enforced filtering by mode.
    const hasVideo = !!(payload as { video?: unknown }).video;
    const hasAudio = !!(payload as { audio?: unknown }).audio;
    if (hasVideo && !this.degradation.shouldForwardVideo()) {
      // Drop video silently (saves upstream cost).
      return;
    }
    if (hasAudio && !this.degradation.shouldForwardAudio()) {
      return;
    }

    // Strip our meta key before forwarding.
    const clean = { ...payload };
    delete (clean as { __meta?: unknown }).__meta;
    this.upstream?.send({ realtimeInput: clean });
  }

  private recordFrameAck(id: string): void {
    const sentAt = this.inFlightFrames.get(id);
    if (!sentAt) return;
    this.inFlightFrames.delete(id);
    const lag = Date.now() - sentAt;
    this.monitor.recordFrameAckLag(lag);
    this.opts.session.metrics.frameAckLagMs = this.monitor.frameLag;
  }

  private handleUpstreamMessage(msg: ServerMessage, raw: Buffer | string): void {
    if ('serverContent' in msg) {
      this.captureModelTurnFragment(msg.serverContent);
    }
    // Forward raw bytes so the client can render audio without re-parsing.
    if (this.opts.clientWs.readyState === 1) {
      try {
        const payload = typeof raw === 'string' ? raw : raw.toString('utf8');
        this.opts.clientWs.send(payload);
      } catch (err) {
        logger.warn({ err }, 'bridge.client.forward-failed');
      }
    }
  }

  private captureUserTurnFromClientContent(payload: Record<string, unknown>): void {
    const turns = (payload as { turns?: Array<{ role?: string; parts?: Array<{ text?: string }> }> }).turns;
    if (!turns) return;
    for (const t of turns) {
      if (t.role !== 'user' || !t.parts) continue;
      const text = t.parts.map((p) => p.text ?? '').join('');
      if (text) this.opts.session.recordTurn('user', text);
    }
  }

  private captureModelTurnFragment(sc: NonNullable<Extract<ServerMessage, { serverContent: unknown }>['serverContent']>): void {
    const parts = sc.modelTurn?.parts ?? [];
    for (const p of parts) {
      if (p.text) this.pendingModelTurn += p.text;
    }
    if (sc.turnComplete) {
      if (this.pendingUserTurn) {
        this.opts.session.recordTurn('user', this.pendingUserTurn);
        this.pendingUserTurn = '';
      }
      if (this.pendingModelTurn) {
        this.opts.session.recordTurn('model', this.pendingModelTurn);
        this.pendingModelTurn = '';
      }
    }
  }

  private sendClient(obj: object): void {
    if (this.opts.clientWs.readyState !== 1) return;
    try {
      this.opts.clientWs.send(JSON.stringify(obj));
    } catch (err) {
      logger.warn({ err }, 'bridge.client.send-failed');
    }
  }
}
