import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

export interface MockGeminiScenario {
  /** Reply to setup with setupComplete immediately. Default: true */
  replyToSetup?: boolean;
  /** Send a sessionResumptionUpdate after N ms of being open. */
  emitHandleAfterMs?: number;
  /** Send goAway after N ms with given timeLeft. */
  emitGoAwayAfterMs?: number;
  /** Close abruptly after N ms. */
  closeAfterMs?: number;
  /** Custom message sequence (each entry is JSON sent to the client). */
  customMessages?: Array<{ delayMs: number; payload: object }>;
}

export interface MockGeminiHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
  /** Connections opened against this mock. */
  connections: WebSocket[];
  /** Setup messages received per connection (parsed JSON). */
  receivedSetups: object[];
  /** All non-setup messages received from clients. */
  received: object[];
}

/**
 * Spins up a tiny WebSocket server that mimics enough of Gemini Live's behaviors to
 * verify reconnect/resumption/goAway logic without burning real API quota.
 */
export async function startMockGemini(scenario: MockGeminiScenario = {}): Promise<MockGeminiHandle> {
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });

  const connections: WebSocket[] = [];
  const receivedSetups: object[] = [];
  const received: object[] = [];

  wss.on('connection', (ws) => {
    connections.push(ws);
    let setupSeen = false;

    ws.on('message', (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!setupSeen && 'setup' in msg) {
        setupSeen = true;
        receivedSetups.push(msg);
        if (scenario.replyToSetup !== false) {
          ws.send(JSON.stringify({ setupComplete: {} }));
        }
        if (scenario.emitHandleAfterMs !== undefined) {
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  sessionResumptionUpdate: { newHandle: 'mock-handle-' + Date.now(), resumable: true },
                }),
              );
            }
          }, scenario.emitHandleAfterMs);
        }
        if (scenario.emitGoAwayAfterMs !== undefined) {
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ goAway: { timeLeft: '2s' } }));
            }
          }, scenario.emitGoAwayAfterMs);
        }
        if (scenario.closeAfterMs !== undefined) {
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'mock-abrupt-close');
          }, scenario.closeAfterMs);
        }
        for (const cm of scenario.customMessages ?? []) {
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cm.payload));
          }, cm.delayMs);
        }
        return;
      }
      received.push(msg);
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const port = (http.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    connections,
    receivedSetups,
    received,
    async close() {
      for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}
