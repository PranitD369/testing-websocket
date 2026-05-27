# Architecture

```
┌──────────────────┐   WebSocket (app-level   ┌──────────────────────┐    WebSocket (native ping/pong)   ┌──────────────────┐
│  Browser client  │ ◄──── ping/pong ───────► │   Fastify Proxy      │ ◄────── upstream ───────────────► │  Gemini Live API │
│  (PWA / camera)  │      realtimeInput       │  (Node + TypeScript) │       sessionResumption           │   (Google)       │
└──────────────────┘      modeChange          │                      │       goAway / serverContent      └──────────────────┘
                          frameAck            │                      │
                                              │   POST /fallback/    ├──── HTTPS (one-shot multipart) ──► Gemini REST
                                              │   photo              │       generateContent
                                              └──────────────────────┘
```

## Why a proxy at all

The product is a React PWA. A browser cannot send native WebSocket ping frames, cannot keep an API key off the device, and cannot apply server-side cost controls. A thin Fastify proxy sits between client and Gemini and does the things only a server can do:

- **Authenticates** to Gemini with the API key (never reaches the browser).
- **Owns session state** (resumption handle, transcript, last-known mode) so the same logical session survives many WS connections.
- **Decides degradation** based on real network telemetry, and enforces it server-side (a malicious or buggy client cannot blow through quota by ignoring the hint).
- **Heartbeats both legs** with appropriate mechanisms (app-level JSON for browser, native WS frames for Gemini).
- **Reconnects upstream** without the client seeing a gap, using Gemini's `goAway.timeLeft` to open a replacement WS preemptively.

## Module map

| File | Role |
|---|---|
| `src/server.ts` | Fastify bootstrap, plugin wiring, signal handlers |
| `src/config.ts` | zod-validated env loader (throws on missing key) |
| `src/routes/ws.ts` | `/ws` upgrade — creates a `Bridge` per connection |
| `src/routes/fallback.ts` | `POST /fallback/photo` — multipart → REST call |
| `src/proxy/bridge.ts` | The runtime glue: client WS ↔ upstream supervisor, applies degradation, captures transcript |
| `src/gemini/liveClient.ts` | One WS to Gemini Live: setup, native heartbeat, message parsing |
| `src/gemini/restClient.ts` | One REST call for the photo fallback path |
| `src/gemini/liveTypes.ts` | Discriminated-union types for Live messages |
| `src/session/Session.ts` | Per-session state: handle, transcript, mode, metrics |
| `src/session/SessionManager.ts` | `Map<sessionId, Session>` with TTL sweeper |
| `src/reliability/heartbeat.ts` | `AppHeartbeat` (browser leg) + `NativeHeartbeat` (Gemini leg) |
| `src/reliability/bandwidthMonitor.ts` | RTT EWMA, pong-miss, frame-ack lag |
| `src/reliability/degradation.ts` | Mode state machine with hysteresis |
| `src/reliability/reconnect.ts` | `UpstreamSupervisor` — reconnects, handles `goAway`, persists handle |

## A single client message: end-to-end

1. Client `getUserMedia` captures a 320×240 JPEG frame and an opus audio chunk.
2. Client sends `{type:"realtimeInput", payload:{ video:{...}, __meta:{frameId} }}` over `/ws`.
3. `Bridge.handleClientMessage` records `inFlightFrames.set(frameId, now)` and asks `degradation.shouldForwardVideo()`.
4. If forwarding is allowed, the `__meta` is stripped and the `realtimeInput` is sent through `UpstreamSupervisor.send()` to the current `LiveClient`.
5. Gemini eventually streams `serverContent` (audio PCM) back. `LiveClient` parses, `Bridge` captures any text into the transcript, then forwards the raw JSON to the client WS unmodified.
6. The browser plays the PCM audio at 24kHz.
7. The client also sends `{type:"frameAck", id:frameId}` back (this stand-in models a real send→ack RTT). `Bridge.recordFrameAck` updates the bandwidth monitor.

## Why client mirrors server-side state

The client has its own reconnect loop, its own session-id persistence (`localStorage`), and its own UI mode badge. That's deliberate: the *server* decides the canonical mode and emits `modeChange`; the client reflects it. The duplication is one-way (server → client). The client never tells the server "you're in HD"; the only thing it can volunteer is `forceMode`, which is a request, not an assertion.
