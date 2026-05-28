import { GoogleGenAI } from '@google/genai';
import type { Config } from '../config.js';
import type { Turn } from '../session/Session.js';
import { logger } from '../util/logger.js';

const SUMMARY_INSTRUCTION =
  'You are summarizing a multimodal troubleshooting transcript so it can be re-injected as context when the live session resumes. ' +
  'Preserve user-reported facts (equipment, symptoms, what they have tried), prior model analyses and recommendations, and any open questions or decisions left unresolved. ' +
  'Output a single paragraph of 100-200 words. Do not include preamble like "Here is the summary".';

export interface PhotoQuestionInput {
  photoBase64: string;
  photoMimeType: string;
  audioBase64?: string;
  audioMimeType?: string;
  text?: string;
  transcriptSummary?: string;
}

export interface PhotoQuestionResult {
  text: string;
  modelVersion?: string;
}

/**
 * Lower-bandwidth path: send one photo + (optional) audio question to Gemini REST and get a text answer.
 * The caller is responsible for client-side TTS of the returned text (cheap, works on weak signal).
 */
export class GeminiRestClient {
  private readonly client: GoogleGenAI;

  constructor(private readonly config: Config) {
    this.client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  }

  async askPhotoQuestion(input: PhotoQuestionInput): Promise<PhotoQuestionResult> {
    const parts: Array<Record<string, unknown>> = [];

    if (input.transcriptSummary) {
      parts.push({
        text: `Prior conversation context (most recent turns):\n${input.transcriptSummary}\n\n---\n\nThe user has switched to low-bandwidth photo mode. Answer their next question using the photo and any prior context.`,
      });
    }

    parts.push({
      inlineData: { mimeType: input.photoMimeType, data: input.photoBase64 },
    });

    if (input.audioBase64 && input.audioMimeType) {
      parts.push({
        inlineData: { mimeType: input.audioMimeType, data: input.audioBase64 },
      });
    }

    if (input.text) {
      parts.push({ text: input.text });
    }

    const response = await this.client.models.generateContent({
      model: this.config.GEMINI_REST_MODEL,
      contents: [{ role: 'user', parts }],
    });

    const text = response.text ?? '';
    logger.debug({ modelVersion: response.modelVersion, len: text.length }, 'gemini.rest.responded');
    return { text, modelVersion: response.modelVersion };
  }

  /**
   * Compress an older-turn transcript into a single paragraph for systemInstruction injection.
   * Wrapped in Promise.race with the configured timeout so a slow REST call doesn't block reconnect;
   * the SDK doesn't expose AbortSignal, so the underlying HTTP request may still complete in the
   * background — we simply ignore its result if the timeout has already fired.
   */
  async summarizeTurns(turns: Turn[], opts: { timeoutMs: number }): Promise<string> {
    const flattened = turns.map((t) => `${t.role}: ${t.text}`).join('\n');
    const model = this.config.SUMMARY_MODEL;
    const generation = this.client.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [{ text: `${SUMMARY_INSTRUCTION}\n\nTranscript:\n${flattened}` }],
        },
      ],
    });
    const result = await Promise.race([
      generation.then((r) => r.text ?? ''),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('summary-timeout')), opts.timeoutMs),
      ),
    ]);
    return result.trim();
  }
}
