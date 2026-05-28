import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnyServerMessage, CaptureHint, ConnStatus, Mode } from '../lib/types.js';
import { PcmPlayer } from '../lib/audioPlayback.js';
import { loadSessionId, mintSessionId, saveSessionId } from '../lib/sessionId.js';

interface LogEntry {
  ts: string;
  msg: string;
  data?: unknown;
}

export interface ConnectionState {
  sessionId: string;
  status: ConnStatus;
  mode: Mode;
  capture: CaptureHint;
  resuming: boolean;
  rttMs: number | null;
  log: LogEntry[];
}

export interface ConnectionApi {
  state: ConnectionState;
  setSessionId: (id: string) => void;
  connect: (sessionId?: string) => void;
  disconnect: () => void;
  killSocket: () => void;
  resetSession: () => void;
  send: (obj: object) => void;
  forceMode: (mode: Mode) => void;
  setInject: (key: 'dropFrames' | 'stallPongs', value: boolean) => void;
  inject: { dropFrames: boolean; stallPongs: boolean };
  player: PcmPlayer;
  /** Subscribe to raw model-turn audio fragments and turn-complete signals. */
  onServerContent: (cb: (msg: AnyServerMessage) => void) => () => void;
}

const MAX_LOG = 200;
const MAX_RECONNECTS = 12;

function nowTs(): string {
  return new Date().toISOString().slice(11, 19);
}

export function useConnection(): ConnectionApi {
  const [sessionId, setSessionIdState] = useState<string>(() => loadSessionId());
  const [status, setStatus] = useState<ConnStatus>('disconnected');
  const [mode, setMode] = useState<Mode>('HD_VIDEO');
  const [capture, setCapture] = useState<CaptureHint>({ maxFps: 1, audioOnly: false, photoMode: false });
  const [resuming, setResuming] = useState(false);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [inject, setInjectState] = useState({ dropFrames: false, stallPongs: false });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const manualDisconnect = useRef(false);
  const playerRef = useRef<PcmPlayer>(new PcmPlayer());
  const subscribers = useRef<Set<(m: AnyServerMessage) => void>>(new Set());
  const injectRef = useRef(inject);
  injectRef.current = inject;

  const pushLog = useCallback((msg: string, data?: unknown) => {
    setLog((prev) => {
      const next = [{ ts: nowTs(), msg, data }, ...prev];
      return next.length > MAX_LOG ? next.slice(0, MAX_LOG) : next;
    });
    console.log(msg, data ?? '');
  }, []);

  const send = useCallback((obj: object) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (
      injectRef.current.dropFrames &&
      (obj as { type?: string }).type === 'realtimeInput' &&
      Math.random() < 0.5
    ) {
      return;
    }
    ws.send(JSON.stringify(obj));
  }, []);

  const connectInternal = useCallback(
    (idOverride?: string) => {
      const existing = wsRef.current;
      if (existing && existing.readyState !== WebSocket.CLOSED) {
        pushLog('ws.already-open');
        return;
      }
      manualDisconnect.current = false;
      let id = idOverride?.trim() || sessionId.trim() || loadSessionId();
      if (!id) {
        id = mintSessionId();
      }
      setSessionIdState(id);
      saveSessionId(id);

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws?sessionId=${encodeURIComponent(id)}`;
      pushLog('ws.connecting', { url });
      setStatus('connecting');

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        reconnectAttempts.current = 0;
        setStatus('connected');
        pushLog('ws.open');
      });

      ws.addEventListener('message', (ev) => {
        let msg: AnyServerMessage;
        try {
          const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if ('type' in msg) {
          switch (msg.type) {
            case 'ping':
              if (!injectRef.current.stallPongs && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
                setRttMs(Date.now() - msg.t);
              }
              return;
            case 'hello':
              setMode(msg.mode);
              setCapture(msg.capture);
              setResuming(msg.resuming);
              pushLog('hello', msg);
              return;
            case 'modeChange':
              setMode(msg.mode);
              setCapture(msg.capture);
              pushLog('modeChange', msg);
              return;
            case 'upstreamReady':
              pushLog('upstream.ready');
              return;
            case 'upstreamGaveUp':
              pushLog('upstream.giveup', msg.message);
              return;
          }
        }
        // Gemini passthrough (serverContent, setupComplete, goAway, sessionResumptionUpdate).
        if ('serverContent' in msg) {
          const sc = msg.serverContent;
          for (const part of sc.modelTurn?.parts ?? []) {
            if (part.text) pushLog('model.text', part.text);
            if (part.inlineData?.mimeType?.startsWith('audio/')) {
              playerRef.current.play(part.inlineData.data);
            }
          }
          if (sc.turnComplete) pushLog('turn.complete');
          if (sc.interrupted) {
            pushLog('turn.interrupted');
            playerRef.current.interrupt();
          }
        }
        if ('setupComplete' in msg) pushLog('upstream.setupComplete');
        if ('goAway' in msg) pushLog('upstream.goAway', msg.goAway);
        if ('sessionResumptionUpdate' in msg) {
          pushLog('upstream.handle.updated', { resumable: msg.sessionResumptionUpdate.resumable });
        }
        for (const cb of subscribers.current) cb(msg);
      });

      ws.addEventListener('close', (ev) => {
        pushLog('ws.close', { code: ev.code, reason: ev.reason });
        setStatus('disconnected');
        wsRef.current = null;
        if (!manualDisconnect.current) {
          reconnectAttempts.current += 1;
          if (reconnectAttempts.current > MAX_RECONNECTS) {
            pushLog('ws.reconnect.giveup');
            return;
          }
          const base = Math.min(250 * Math.pow(2, reconnectAttempts.current), 30_000);
          const delay = Math.round(base + Math.random() * 0.3 * base);
          pushLog('ws.reconnect.in', { delay, attempt: reconnectAttempts.current });
          setStatus('reconnecting');
          reconnectTimer.current = window.setTimeout(() => connectInternal(), delay);
        }
      });

      ws.addEventListener('error', () => {
        setStatus('error');
        pushLog('ws.error');
      });
    },
    [sessionId, pushLog],
  );

  const disconnect = useCallback(() => {
    manualDisconnect.current = true;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    wsRef.current?.close(1000, 'manual');
  }, []);

  const killSocket = useCallback(() => {
    wsRef.current?.close(4001, 'manual-kill');
  }, []);

  const resetSession = useCallback(() => {
    setSessionIdState('');
    saveSessionId('');
    setResuming(false);
  }, []);

  const setSessionId = useCallback((id: string) => {
    setSessionIdState(id);
    if (id) saveSessionId(id);
  }, []);

  const forceMode = useCallback(
    (m: Mode) => {
      send({ type: 'forceMode', mode: m });
    },
    [send],
  );

  const setInject = useCallback((key: 'dropFrames' | 'stallPongs', value: boolean) => {
    setInjectState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const onServerContent = useCallback((cb: (m: AnyServerMessage) => void) => {
    subscribers.current.add(cb);
    return () => {
      subscribers.current.delete(cb);
    };
  }, []);

  // Auto-connect if we already have a session id when the app loads.
  useEffect(() => {
    if (sessionId && !wsRef.current) {
      connectInternal(sessionId);
    }
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close(1000, 'unmount');
      playerRef.current.close();
    };
    // Intentionally only on mount: subsequent reconnects flow through user actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state: { sessionId, status, mode, capture, resuming, rttMs, log },
    setSessionId,
    connect: connectInternal,
    disconnect,
    killSocket,
    resetSession,
    send,
    forceMode,
    setInject,
    inject,
    player: playerRef.current,
    onServerContent,
  };
}
