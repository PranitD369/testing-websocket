# Gemini Live API: behaviors used by this lab

This is the cheat sheet of Gemini Live behaviors that drove design decisions, with links to the relevant docs.

## 1. Setup is a required first message

Every WebSocket starts with a [`BidiGenerateContentSetup`](https://ai.google.dev/api/live#bidigeneratecontentsetup). Gemini won't respond to any `realtimeInput` or `clientContent` until it sends back `setupComplete`. The lab's `LiveClient.sendSetup` constructs this; `Bridge` and `UpstreamSupervisor` both wait for `setupComplete` before considering the upstream "ready."

## 2. Connection time limits

From the [Live API capabilities guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities):

> The default maximum session length is **10 minutes for audio and video** sessions and **15 minutes for audio-only** sessions.

These are hard ceilings. Every long conversation will be disconnected. Resumption (see §4) and `goAway` handling (see §5) exist precisely to make this invisible to the user.

## 3. `contextWindowCompression` to extend single connections

The same docs describe enabling sliding-window compression:

```json
{
  "contextWindowCompression": {
    "slidingWindow": {},
    "triggerTokens": 25000
  }
}
```

Without this, long sessions get cut off when context fills up. With it, the model drops older turns once `triggerTokens` is crossed. The lab passes this on every setup (via `CONTEXT_COMPRESS_TRIGGER_TOKENS` env).

## 4. `sessionResumption` is the cleanest way to survive reconnects — when the model supports it

From [Session management with Live API](https://ai.google.dev/gemini-api/docs/live-session):

- Add `"sessionResumption": {}` to setup to opt in.
- Gemini sends `sessionResumptionUpdate.newHandle` messages with `resumable:true` whenever the session is in a state that can be resumed.
- Pass the most recent `newHandle` as `sessionResumption.handle` in the *next* connection's setup to pick up where you left off.
- Tokens valid ~2h after disconnect; resumption chains support up to 24h continuity.

The lab persists the handle on the `Session` object server-side (NOT in the client) — the client only needs its own `sessionId`; the server's lookup recovers the handle on reconnect. The handle (and the full transcript) is also written through to Postgres so it survives process restarts, see [database.md](database.md).

**Important contract:** only persist `newHandle` when `resumable:true`. Otherwise the handle may be invalid and the next setup will fail. `UpstreamSupervisor.handleMessage` enforces this.

**Catch — the native-audio model doesn't accept it.** As of writing, `gemini-2.5-flash-native-audio-latest` closes the WS with code `1011` on the first turn whenever `sessionResumption` is present in the setup. So the lab keeps `ENABLE_SESSION_RESUMPTION=false` by default and falls back to a manual hybrid replay: `Session.buildSeedContext` produces a `summary` (older turns compressed by Gemini REST into a single paragraph and cached on the `Session` / in Postgres, so most reconnects don't repay the LLM cost) for `systemInstruction`, plus a `replay` array of the last 10 turns sent as `clientContent` immediately after `setupComplete` (`LiveClient.sendReplayIfAny`). The model is seeded with the same context Gemini's own resumption would have restored. A summarizer timeout falls back to raw concat so reconnect is never blocked. Flip `ENABLE_SESSION_RESUMPTION=true` and the two paths coexist when you move to a model that supports them.

## 5. `goAway` is a graceful warning, not an error

Before forcibly disconnecting, Gemini sends:

```json
{ "goAway": { "timeLeft": "30s" } }
```

This is the cue to open a *replacement* connection (with the latest resumption handle) before the current one dies. `UpstreamSupervisor.openReplacement` does this. Once the replacement's `setupComplete` arrives, we atomically swap pointers and close the old WS. The client never sees a gap.

The `timeLeft` value gives you a budget for the swap. Even on a 2s warning, a fresh WS handshake usually completes in well under a second.

## 6. `realtimeInput` vs `clientContent`

- **`realtimeInput`** is for continuous media (audio/video chunks, "raw" interactive turns). Gemini treats turn boundaries implicitly.
- **`clientContent`** is for structured turn-based messages with explicit `turnComplete`. Useful for sending pure-text questions or replaying a transcript after resumption.

The lab uses `realtimeInput` for camera+mic and `clientContent` for the rare text path.

## 7. Audio output format

Gemini Live audio replies are **16-bit PCM, little-endian, 24kHz mono** delivered as base64 inside `serverContent.modelTurn.parts[].inlineData`. The client (`client/app.js`) decodes via `AudioContext` at 24000 Hz.

## 8. REST `generateContent` for the photo fallback

The lower-bandwidth path uses the standard [REST API](https://ai.google.dev/api/generate-content):
- multimodal `contents.parts` with `inlineData` for image and audio
- transcript summary injected as a leading text part for continuity
- response text returned and (optionally) spoken via client `speechSynthesis`

This path is *not* live-streaming — it's a one-shot request/response, which is the whole point: it works on networks too poor for a streaming WS.

## 9. Model names rotate

The Live model identifier is preview-grade and Google rotates the name. The lab loads `GEMINI_LIVE_MODEL` from env (`gemini-2.5-flash-live-preview` at the time of this writing) so updates are one-line. If you get setup-time errors like `model not found`, check <https://ai.google.dev/gemini-api/docs/models> for the current Live-capable model.

## 10. Recommended reading order for new contributors

1. [Get started with WebSockets](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket)
2. [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
3. [Session management](https://ai.google.dev/gemini-api/docs/live-session)
4. [Best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices)
5. [API reference for `BidiGenerateContent`](https://ai.google.dev/api/live)
