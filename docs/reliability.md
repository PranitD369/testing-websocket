# Reliability Features

Each section below: **problem** → **why a naive proxy fails** → **what we do** → **where to find it in the code**.

---

## 1. Bidirectional heartbeat

**Problem.** TCP/WebSocket connections can sit "half-open" for minutes after the network drops — the OS won't report the failure until something tries to write. On a job site with intermittent cell signal, this means the user is staring at a frozen UI thinking the AI is working when in reality the socket died 90 seconds ago.

**Why a naive proxy fails.** A browser cannot send native WebSocket ping frames at all (the `WebSocket` API has no `.ping()` method), so a naive proxy that relies on TCP/WS keepalives sees nothing wrong with the browser leg even when the device is offline. The Gemini leg fares slightly better — Node's `ws` library does support ping/pong — but only if you actually call it.

**What we do.**
- **Browser ↔ proxy:** application-level `{type:"ping",t}` / `{type:"pong",t}` JSON pings every 10s. The proxy uses the round-trip to compute RTT (an input to degradation, see §3) and terminates the socket if no pong arrives within 25s.
- **Proxy ↔ Gemini:** native `ws.ping()` every 10s with the `'pong'` event used to refresh `lastPongAt`. Same 25s timeout, `ws.terminate()` on timeout to force the close handler to run.

Both halves wrap a single class hierarchy (`AppHeartbeat`, `NativeHeartbeat`) sharing the same interface so the proxy can reason about either leg uniformly.

**Code:** `src/reliability/heartbeat.ts`, used by `Bridge` (browser leg) and `LiveClient` (Gemini leg).

---

## 2. Reconnection with session resumption

**Problem.** Gemini Live caps a single WebSocket at roughly **10 minutes for video+audio sessions** (about 15 minutes for audio-only). That's a hard ceiling, not a soft target — every long conversation will be forcibly disconnected. On top of this, cell signal drops cause spurious closes. A user mid-troubleshoot losing all conversational context every few minutes is not a working product.

**Why a naive proxy fails.** Calling `ws.connect()` again in `onclose` gives you a fresh model with no memory of the prior turns. The model loses the user's question, the equipment context, and any reasoning the model had built up.

**What we do.**

- **Per-session state lives on the server.** `SessionManager` keys sessions by a client-generated `sessionId` (stored in browser `localStorage`). A reconnecting client passes `?sessionId=...` and the proxy finds the same `Session` object with its `resumptionHandle`, transcript, and mode already populated.
- **State is durable in Postgres.** Every `recordTurn` and resumption-handle update is written through to `sessions` / `turns` (`src/session/postgresStore.ts`). If the Node process is restarted or the in-memory entry is evicted, the next connect with the same `sessionId` rehydrates the `Session` from the DB (`session.loaded.from-db` in logs). See [docs/database.md](database.md) for setup.
- **Hybrid context replay** when the upstream model doesn't support `sessionResumption`. On every fresh Gemini WS, `Session.buildSeedContext(N)` splits the transcript into a `summary` (older turns flattened, sent as `systemInstruction`) plus a `replay` array (the most recent `CONTEXT_REPLAY_TAIL_TURNS` turns, sent as one `clientContent` batch with `turnComplete:false` after `setupComplete`). The model gets both long-range context and live working context without needing Gemini's native resumption — which the `gemini-2.5-flash-native-audio-*` family rejects.
- **Native `sessionResumption` is still wired** (gated behind `ENABLE_SESSION_RESUMPTION`) for the day we move to a model that supports it: `LiveClient.sendSetup` reads `sessionResumption.handle`, and `UpstreamSupervisor` listens for `sessionResumptionUpdate` and only persists `newHandle` when `resumable:true`. Both paths can coexist; the replay seed is harmless if Gemini also restores its own state.
- **`goAway` is a gift, not a failure.** When Gemini signals an imminent forced disconnect, `UpstreamSupervisor.openReplacement()` opens a *parallel* connection (with seed + handle) and swaps pointers when its `setupComplete` arrives. The client never sees a gap.
- **Client-side reconnect** uses jittered exponential backoff (250ms → 30s cap), bounded by `MAX_RECONNECT_ATTEMPTS`.

**Code:** `src/reliability/reconnect.ts` (supervisor + seed-context wiring), `src/gemini/liveClient.ts` (setup with handle, replay batch after `setupComplete`), `src/session/Session.ts` (`buildSeedContext`), `src/session/SessionManager.ts` (DB-backed rehydrate), `src/session/postgresStore.ts` (persistence). Client-side in `client/app.js`.

---

## 3. Graceful degradation

**Problem.** When bandwidth drops, the worst thing the proxy can do is keep streaming 1fps JPEGs as if everything's fine. Frames pile up in send queues, RTT spikes further, and the user perceives the AI as broken. The right behavior is to *shed load* before things get bad.

**Why a naive proxy fails.** It has no telemetry on the client leg — and even if it did, it has no enforcement: a buggy client could ignore "please send less" and continue draining quota.

**What we do.**

- **Three signals feed a single quality score** (`src/reliability/bandwidthMonitor.ts`):
  - RTT EWMA from the heartbeat
  - Consecutive pong-miss count
  - Frame-ack lag (client echoes a small ack after receiving each frame — the proxy measures the delta from send to ack)
- **A state machine** in `src/reliability/degradation.ts` transitions through four modes:

  | Mode | Trigger | Behavior |
  |---|---|---|
  | `HD_VIDEO` | RTT < 200ms, no misses | 1 fps full-quality JPEGs + audio |
  | `LD_VIDEO` | RTT 200–500ms or 1 miss | 0.5 fps, downscale on client |
  | `AUDIO_ONLY` | RTT > 500ms or 2 misses | Server drops all video frames; audio still streams |
  | `PHOTO_MODE` | RTT > 1500ms or 3 misses | Server emits `modeChange`, client switches UI to photo path |
- **Downgrades are immediate; upgrades hold down for 5 seconds** of sustained improvement to prevent oscillation when the network is right on the threshold.
- **Server enforces, client suggests.** `Bridge.handleRealtimeInput` calls `degradation.shouldForwardVideo()` before relaying. Even if the client misbehaves, the proxy refuses to forward video in `AUDIO_ONLY` mode.

**Code:** `src/reliability/bandwidthMonitor.ts`, `src/reliability/degradation.ts`, applied at `src/proxy/bridge.ts`.

---

## 4. Photo-based fallback

**Problem.** Some networks just cannot sustain a WebSocket at all. The user is in a parking garage, on 1-bar 2G, behind a captive portal. Telling them "sorry, no AI today" isn't acceptable — the photo path was designed precisely for these conditions.

**Why a naive proxy fails.** It only has a streaming endpoint. When the stream fails, there's no graceful alternative.

**What we do.**

- **`POST /fallback/photo`** accepts `multipart/form-data` with `photo` (required), `audio` (optional), `text` (optional), `sessionId` (optional).
- The handler calls Gemini REST `models.generateContent` on `gemini-2.5-flash` with inline image + audio parts.
- If a `sessionId` is provided, we inject `Session.transcriptSummary()` as the leading text part — so the photo question is answered *with awareness* of what the user was just discussing over the live socket before signal collapsed.
- The reply is recorded back into `Session.transcript` so that when WS comes back, the model picks up the conversation including the photo turn.

**Photo mode is peer to live mode, not strictly a fallback.** A user can switch into photo mode deliberately (the client's "Force photo mode" button) when they know they're entering a low-signal area.

**Code:** `src/routes/fallback.ts`, `src/gemini/restClient.ts`, transcript handling in `src/proxy/bridge.ts` and `src/session/Session.ts`.

---

## Cross-cutting invariants

- **Session id is client-owned.** The browser generates it, persists it in `localStorage`, and includes it on every connect. The proxy trusts the id and looks up state.
- **Server-side is the source of truth for mode.** Client hints (`forceMode`) are advisory; `modeChange` from the server is binding.
- **Resumption handle is updated only on `resumable:true`.** Otherwise we'd cache a dead handle and the next reconnect would silently fail.
- **Token budgets degrade automatically.** `contextWindowCompression.slidingWindow` lets long sessions stretch past Gemini's default context limit without blowing up.
