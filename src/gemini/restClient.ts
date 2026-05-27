import { GoogleGenAI } from '@google/genai';
import type { Config } from '../config.js';
import { logger } from '../util/logger.js';

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
}
