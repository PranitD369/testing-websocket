import type { FastifyInstance } from 'fastify';
import { GeminiRestClient } from '../gemini/restClient.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { Config } from '../config.js';
import { logger } from '../util/logger.js';

export interface FallbackRouteDeps {
  config: Config;
  sessions: SessionManager;
}

/**
 * POST /fallback/photo (multipart/form-data)
 *   photo:  required JPEG/PNG file
 *   audio:  optional audio file (webm/opus, pcm, etc.)
 *   text:   optional text question (fallback if no audio)
 *   sessionId: optional - if present, transcript context is injected and reply is recorded
 *
 * Lower-bandwidth path: one round-trip REST call instead of a streaming WS.
 */
export async function registerFallbackRoute(app: FastifyInstance, deps: FallbackRouteDeps): Promise<void> {
  const rest = new GeminiRestClient(deps.config);

  app.post('/fallback/photo', async (req, reply) => {
    const parts = req.parts();

    let photoBase64: string | undefined;
    let photoMimeType: string | undefined;
    let audioBase64: string | undefined;
    let audioMimeType: string | undefined;
    let text: string | undefined;
    let sessionId: string | undefined;

    for await (const part of parts) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        const b64 = buf.toString('base64');
        if (part.fieldname === 'photo') {
          photoBase64 = b64;
          photoMimeType = part.mimetype || 'image/jpeg';
        } else if (part.fieldname === 'audio') {
          audioBase64 = b64;
          audioMimeType = part.mimetype || 'audio/webm';
        }
      } else {
        if (part.fieldname === 'text') text = String(part.value);
        if (part.fieldname === 'sessionId') sessionId = String(part.value);
      }
    }

    if (!photoBase64 || !photoMimeType) {
      reply.code(400);
      return { error: 'photo (file) is required' };
    }

    const session = sessionId ? await deps.sessions.getOrLoad(sessionId) : undefined;
    const transcriptSummary = session?.transcriptSummary();

    try {
      const result = await rest.askPhotoQuestion({
        photoBase64,
        photoMimeType,
        audioBase64,
        audioMimeType,
        text,
        transcriptSummary,
      });

      if (session) {
        if (text) session.recordTurn('user', text);
        session.recordTurn('model', result.text);
      }

      logger.info(
        { sessionId, modelVersion: result.modelVersion, len: result.text.length },
        'fallback.photo.responded',
      );

      return { text: result.text, modelVersion: result.modelVersion };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'fallback.photo.failed');
      reply.code(502);
      return { error: 'upstream-failure', message };
    }
  });
}
