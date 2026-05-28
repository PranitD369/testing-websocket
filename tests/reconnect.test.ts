import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startMockGemini, type MockGeminiHandle } from './fixtures/mockGemini.js';
import { Session } from '../src/session/Session.js';
import { UpstreamSupervisor } from '../src/reliability/reconnect.js';
import { LiveClient } from '../src/gemini/liveClient.js';
import type { Config } from '../src/config.js';

function makeConfig(): Config {
  return {
    GEMINI_API_KEY: 'test-key',
    PORT: 0,
    LOG_LEVEL: 'error',
    GEMINI_LIVE_MODEL: 'mock-model',
    GEMINI_REST_MODEL: 'mock-rest',
    HEARTBEAT_INTERVAL_MS: 1000,
    HEARTBEAT_TIMEOUT_MS: 30_000,
    MAX_RECONNECT_ATTEMPTS: 3,
    DEGRADATION_RTT_LD_MS: 200,
    DEGRADATION_RTT_AUDIO_MS: 500,
    DEGRADATION_RTT_PHOTO_MS: 1500,
    SESSION_TTL_HOURS: 1,
    CONTEXT_COMPRESS_TRIGGER_TOKENS: 25_000,
    ENABLE_SESSION_RESUMPTION: false,
    ENABLE_CONTEXT_COMPRESSION: false,
    DB_POOL_MAX: 10,
    CONTEXT_REPLAY_TAIL_TURNS: 3,
  } as Config;
}

let mock: MockGeminiHandle;

afterEach(async () => {
  if (mock) await mock.close();
  delete process.env.GEMINI_LIVE_URL_OVERRIDE;
});

describe('UpstreamSupervisor (logic)', () => {
  it('persists resumption handle from sessionResumptionUpdate', () => {
    const session = new Session('s1');
    const config = makeConfig();
    const sup = new UpstreamSupervisor({
      config,
      session,
      onMessage: () => {},
      onGiveUp: () => {},
      onReady: () => {},
    });

    const sup2 = sup as unknown as { handleMessage: (m: object) => void };
    sup2.handleMessage({ sessionResumptionUpdate: { newHandle: 'h-1', resumable: true } });
    expect(session.resumptionHandle).toBe('h-1');

    sup2.handleMessage({ sessionResumptionUpdate: { newHandle: 'h-2', resumable: false } });
    expect(session.resumptionHandle).toBe('h-1');

    sup2.handleMessage({ sessionResumptionUpdate: { newHandle: 'h-3', resumable: true } });
    expect(session.resumptionHandle).toBe('h-3');
  });
});

describe('mockGemini integration', () => {
  it('accepts setup and emits sessionResumptionUpdate', async () => {
    mock = await startMockGemini({ emitHandleAfterMs: 10 });
    const ws = new (await import('ws')).WebSocket(mock.url);
    await new Promise<void>((res) => ws.on('open', () => res()));
    ws.send(JSON.stringify({ setup: { model: 'mock', sessionResumption: {} } }));

    const messages: Record<string, unknown>[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));

    await new Promise((res) => setTimeout(res, 100));

    expect(messages.find((m) => 'setupComplete' in m)).toBeTruthy();
    const update = messages.find((m) => 'sessionResumptionUpdate' in m);
    expect(update).toBeTruthy();
    ws.close();
  });

  it('emits goAway with timeLeft when configured', async () => {
    mock = await startMockGemini({ emitGoAwayAfterMs: 20 });
    const ws = new (await import('ws')).WebSocket(mock.url);
    await new Promise<void>((res) => ws.on('open', () => res()));
    ws.send(JSON.stringify({ setup: { model: 'mock' } }));

    const messages: Record<string, unknown>[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((res) => setTimeout(res, 100));

    const goAway = messages.find((m) => 'goAway' in m) as { goAway: { timeLeft: string } } | undefined;
    expect(goAway).toBeTruthy();
    expect(goAway?.goAway.timeLeft).toBe('2s');
    ws.close();
  });
});

describe('LiveClient context replay', () => {
  it('sends replay turns as a clientContent batch after setupComplete', async () => {
    mock = await startMockGemini();
    process.env.GEMINI_LIVE_URL_OVERRIDE = mock.url;

    const lc = new LiveClient({
      config: makeConfig(),
      sessionId: 's-replay',
      replayTurns: [
        { role: 'user', text: 'what is this?', at: 1 },
        { role: 'model', text: 'a capacitor', at: 2 },
        { role: 'user', text: 'is it broken?', at: 3 },
      ],
      onMessage: () => {},
      onClose: () => {},
      onOpen: () => {},
      onError: () => {},
    });
    lc.connect();

    // Wait for setup + replay round-trip.
    await new Promise((res) => setTimeout(res, 150));

    const clientContents = mock.received.filter((m) => 'clientContent' in m) as Array<{
      clientContent: { turns: Array<{ role: string; parts: Array<{ text: string }> }>; turnComplete?: boolean };
    }>;
    expect(clientContents).toHaveLength(1);
    expect(clientContents[0]?.clientContent.turns).toHaveLength(3);
    expect(clientContents[0]?.clientContent.turns[0]?.role).toBe('user');
    expect(clientContents[0]?.clientContent.turns[0]?.parts[0]?.text).toBe('what is this?');
    expect(clientContents[0]?.clientContent.turnComplete).toBe(false);

    lc.close();
  });

  it('does not send a replay batch when no replayTurns are configured', async () => {
    mock = await startMockGemini();
    process.env.GEMINI_LIVE_URL_OVERRIDE = mock.url;

    const lc = new LiveClient({
      config: makeConfig(),
      sessionId: 's-no-replay',
      onMessage: () => {},
      onClose: () => {},
      onOpen: () => {},
      onError: () => {},
    });
    lc.connect();
    await new Promise((res) => setTimeout(res, 150));

    const clientContents = mock.received.filter((m) => 'clientContent' in m);
    expect(clientContents).toHaveLength(0);

    lc.close();
  });
});
