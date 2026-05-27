import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { SessionManager } from './session/SessionManager.js';
import { registerWsRoute } from './routes/ws.js';
import { registerFallbackRoute } from './routes/fallback.js';
import { logger } from './util/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const sessions = new SessionManager(config.SESSION_TTL_HOURS);

  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });

  await app.register(websocket, {
    options: { maxPayload: 8 * 1024 * 1024 },
  });
  await app.register(multipart, {
    limits: { fileSize: 20 * 1024 * 1024, files: 2 },
  });

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const clientDir = resolve(__dirname, '..', 'client');
  await app.register(staticPlugin, { root: clientDir, prefix: '/' });

  app.get('/health', async () => ({ ok: true, sessions: sessions.size() }));

  await registerWsRoute(app, { config, sessions });
  await registerFallbackRoute(app, { config, sessions });

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info({ port: config.PORT }, 'server.started');
  } catch (err) {
    logger.fatal({ err }, 'server.start-failed');
    process.exit(1);
  }

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, 'server.shutdown');
    sessions.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'server.fatal');
  process.exit(1);
});
