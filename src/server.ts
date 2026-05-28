import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { SessionManager } from './session/SessionManager.js';
import { MemorySessionStore } from './session/memoryStore.js';
import { PostgresSessionStore } from './session/postgresStore.js';
import { GeminiSummarizer } from './session/summarizer.js';
import { GeminiRestClient } from './gemini/restClient.js';
import type { SessionStore } from './session/store.js';
import { initPool, closePool } from './db/pool.js';
import { initDb } from './db/init.js';
import { registerWsRoute } from './routes/ws.js';
import { registerFallbackRoute } from './routes/fallback.js';
import { logger } from './util/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();

  let store: SessionStore;
  let usingDb = false;
  if (config.DATABASE_URL) {
    const pool = initPool(config.DATABASE_URL, config.DB_POOL_MAX);
    await initDb(pool);
    store = new PostgresSessionStore(pool);
    usingDb = true;
  } else {
    logger.warn('db.disabled DATABASE_URL not set; using in-memory session store');
    store = new MemorySessionStore();
  }

  const sessions = new SessionManager(config.SESSION_TTL_HOURS, store);
  const restClient = new GeminiRestClient(config);
  const summarizer = new GeminiSummarizer(restClient, config.SUMMARY_TIMEOUT_MS);

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

  // The React PWA build (web/dist) is served under /app. SPA fallback rewrites unknown
  // sub-paths to index.html so client-side navigation works after page reload.
  const webDist = resolve(__dirname, '..', 'web', 'dist');
  if (existsSync(webDist)) {
    await app.register(staticPlugin, {
      root: webDist,
      prefix: '/app/',
      decorateReply: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/app/') && req.method === 'GET') {
        reply.sendFile('index.html', webDist);
        return;
      }
      reply.code(404).send({ error: 'not-found' });
    });
    logger.info({ webDist }, 'pwa.served-at /app');
  } else {
    logger.warn({ webDist }, 'pwa.dist-not-found run "npm run build" inside web/ to enable /app');
  }

  app.get('/health', async () => ({ ok: true, sessions: sessions.size(), db: usingDb }));

  await registerWsRoute(app, { config, sessions, summarizer });
  await registerFallbackRoute(app, { config, sessions });

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info({ port: config.PORT, db: usingDb }, 'server.started');
  } catch (err) {
    logger.fatal({ err }, 'server.start-failed');
    process.exit(1);
  }

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, 'server.shutdown');
    sessions.stop();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'server.fatal');
  process.exit(1);
});
