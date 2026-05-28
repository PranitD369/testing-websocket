import type { FastifyInstance } from 'fastify';
import { Bridge } from '../proxy/bridge.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { Config } from '../config.js';
import { logger } from '../util/logger.js';

export interface WsRouteDeps {
  config: Config;
  sessions: SessionManager;
}

/**
 * GET /ws  - WebSocket upgrade endpoint.
 * Query params:
 *   sessionId    - optional client-supplied id (for resumption across reconnect)
 *   inject       - csv of failure-injection toggles (debug only): killGemini, goAway, stallPongs
 */
export async function registerWsRoute(app: FastifyInstance, deps: WsRouteDeps): Promise<void> {
  app.get('/ws', { websocket: true }, async (socket, req) => {
    const url = new URL(req.url ?? '/ws', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    const inject = new Set((url.searchParams.get('inject') ?? '').split(',').filter(Boolean));

    let session;
    try {
      session = await deps.sessions.getOrCreate(sessionId);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'ws.session.load-failed');
      try {
        socket.close(1011, 'session-load-failed');
      } catch {
        /* noop */
      }
      return;
    }

    logger.info(
      {
        sessionId: session.id,
        resuming: !!session.resumptionHandle,
        turns: session.transcript.length,
        inject: Array.from(inject),
      },
      'ws.connect',
    );

    const bridge = new Bridge({
      config: deps.config,
      session,
      clientWs: socket as unknown as import('ws').WebSocket,
      inject,
    });
    bridge.start();

    socket.on('close', () => {
      bridge.shutdown();
    });
  });
}
