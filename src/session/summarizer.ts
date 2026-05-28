import type { Turn } from './Session.js';
import type { GeminiRestClient } from '../gemini/restClient.js';

export interface Summarizer {
  summarize(turns: Turn[]): Promise<string>;
}

/**
 * Wraps GeminiRestClient.summarizeTurns with a fixed timeout drawn from config.
 * The caller (Session.buildSeedContext) catches throws and falls back to raw concat,
 * so a slow / failed LLM never blocks reconnect.
 */
export class GeminiSummarizer implements Summarizer {
  constructor(
    private readonly rest: GeminiRestClient,
    private readonly timeoutMs: number,
  ) {}

  summarize(turns: Turn[]): Promise<string> {
    return this.rest.summarizeTurns(turns, { timeoutMs: this.timeoutMs });
  }
}
