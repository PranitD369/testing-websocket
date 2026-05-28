import { describe, it, expect, vi } from 'vitest';
import { GeminiSummarizer } from '../src/session/summarizer.js';
import type { GeminiRestClient } from '../src/gemini/restClient.js';

describe('GeminiSummarizer', () => {
  it('forwards turns and timeout to the rest client', async () => {
    const summarizeTurns = vi.fn(async () => 'compressed');
    const rest = { summarizeTurns } as unknown as GeminiRestClient;
    const sut = new GeminiSummarizer(rest, 1234);

    const turns = [
      { role: 'user' as const, text: 'q', at: 1 },
      { role: 'model' as const, text: 'a', at: 2 },
    ];
    const result = await sut.summarize(turns);

    expect(result).toBe('compressed');
    expect(summarizeTurns).toHaveBeenCalledTimes(1);
    expect(summarizeTurns).toHaveBeenCalledWith(turns, { timeoutMs: 1234 });
  });

  it('propagates errors so the Session can fall back to raw concat', async () => {
    const summarizeTurns = vi.fn(async () => {
      throw new Error('summary-timeout');
    });
    const rest = { summarizeTurns } as unknown as GeminiRestClient;
    const sut = new GeminiSummarizer(rest, 100);

    await expect(sut.summarize([])).rejects.toThrow('summary-timeout');
  });
});
