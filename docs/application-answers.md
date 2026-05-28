# Draft answers to the three application questions

These are draft answers grounded in the lab implementation in this repo. Edit the personal-experience portions before sending.

---

## 1. Describe one real-time / streaming system you've built and shipped. What was the hardest reliability problem and how did you solve it?

**Draft:**

The most representative example is the WebSocket proxy in this repository — a Fastify backend that bridges a browser client to Google's Gemini Live API for real-time multimodal AI assistance, with all the reliability features the job posting describes (`docs/reliability.md`).

The hardest reliability problem with this class of system isn't *detecting* a dead connection — it's making the recovery invisible. A naive `onclose -> reconnect` loop loses the conversation, which is unacceptable for an in-progress troubleshooting session. The solution had three parts:

1. **Server-side session state keyed by a client-owned id, durable in Postgres.** The browser persists its `sessionId` in `localStorage` and includes it on every `/ws` connect. The server's `SessionManager` looks up the same `Session` across WS connections; if it's not in memory (process restart, eviction), it rehydrates from `sessions`/`turns` tables (`src/session/SessionManager.ts`, `src/session/postgresStore.ts`). Reconnect is no longer "new session" — it's "same session, new transport," and a server redeploy doesn't lose the conversation either.

2. **Use the upstream API's resumption mechanism when the model supports it, hybrid replay when it doesn't.** Gemini Live exposes `sessionResumption` with `newHandle`/`resumable` semantics, and the lab persists the handle on the `Session`. But the current `gemini-2.5-flash-native-audio-*` family rejects that field, so the lab also implements a hybrid manual replay: `Session.buildSeedContext` splits the transcript into a summary (older turns → `systemInstruction`) and a tail (last N turns → one `clientContent` batch with `turnComplete:false` after `setupComplete`). Same outcome — the model has the context — without depending on a feature the chosen model doesn't support.

3. **Treat `goAway` as a normal event, not an error.** Gemini sends `goAway.timeLeft` before forced disconnects (every ~10 minutes for video sessions). `UpstreamSupervisor.openReplacement` opens a parallel WS with the latest handle and seed context and swaps pointers when its `setupComplete` arrives. Client sees zero gap.

The mental model that matters: a "session" is a logical conversation; a WebSocket is an ephemeral transport. Conflating them is the root cause of most reliability bugs in systems like this.

*(Personalize: replace the opening paragraph with the actual production system you shipped, then keep the structural points — they generalize.)*

---

## 2. We proxy Gemini Live over a WebSocket and sessions intermittently drop with "CLOSED." What are the first three causes you'd investigate?

**Draft:**

1. **Gemini's hard session caps and missing resumption.** Gemini Live caps a single WS at ~10 minutes (video+audio) or ~15 minutes (audio-only). If you're not handling `goAway.timeLeft` and re-opening with `sessionResumption.handle`, every long conversation will look like a random "CLOSED." The fix is straightforward: subscribe to `sessionResumptionUpdate`, persist `newHandle` server-side, and proactively open a replacement WS when `goAway` arrives. (See `docs/reliability.md` §2.)

2. **Heartbeat asymmetry.** Browsers can't send native WS ping frames, so a proxy that relies on ping/pong on the browser leg gets nothing. On weak cell signal, the OS may not surface a half-open connection for minutes — the user sees a frozen UI and the server has no idea the device is gone. The fix is an application-level JSON ping (`{type:"ping",t}`) with a tight timeout (we use 25s) and `terminate()` on miss. Symmetrically, the upstream leg needs native `ws.ping()` with the same timeout. (See `src/reliability/heartbeat.ts`.)

3. **Setup or resumption-handle invalidation.** If "CLOSED" is happening *right after open*, the cause is usually one of: (a) using a stale resumption handle that Gemini rejects, (b) passing the wrong model name (the Live model id rotates), or (c) sending unsupported `responseModalities` for the chosen model. The fix is to log raw setup payloads and close-codes/reasons. The lab's `LiveClient` logs both (`src/gemini/liveClient.ts:55`).

If those three are clean, I'd next look at proxy-side resource exhaustion (Node's heap on long-running sessions if frame buffers leak), then upstream regional issues (the Gemini WS can fail over and surface as 1011).

---

## 3. How would you keep a real-time app usable for a user on weak or intermittent cell signal?

**Draft:**

The principle is **shed load before it gets bad, and have a non-streaming fallback for when streaming isn't possible at all.** Concretely:

**Detect early.** Three signals together give you a much better picture than any one alone:
- RTT EWMA on the heartbeat (catches latency creep)
- Consecutive pong misses (catches sudden cliffs)
- Frame send→ack lag (catches uplink-specific congestion that pong RTT can miss)

These feed a single `BandwidthMonitor` in this lab (`src/reliability/bandwidthMonitor.ts`).

**Degrade in steps, server-enforced.** A state machine with four modes — `HD_VIDEO` → `LD_VIDEO` → `AUDIO_ONLY` → `PHOTO_MODE` — with immediate downgrades and a 5-second hysteresis on upgrades to prevent flapping (`src/reliability/degradation.ts`). The proxy *drops video frames server-side* in `AUDIO_ONLY` rather than relying on the client to obey hints, because a buggy or old client could otherwise burn quota.

**Reconnect transparently.** Client-side jittered exponential backoff (250ms → 30s) tied to a persistent `sessionId`, so the server reuses the same `Session` and replays Gemini's resumption handle. The user keeps their conversational context across drops they may not even notice.

**Have a peer mode, not just a fallback.** A `POST /fallback/photo` REST endpoint accepts one photo + audio + transcript-summary and returns a text answer (synthesized to speech client-side). This works on networks too poor to sustain a WebSocket. Critically, the photo mode is not just an error path — users can deliberately switch into it when they know they're entering a low-signal area (going into a basement, a freight elevator, behind metal cladding). (`src/routes/fallback.ts`.)

**Operational hygiene.** Log every mode transition and reconnect with a `sessionId` tag so you can answer "what happened on this user's session at 4:17pm" without digging. PostHog (already in their stack) is a good place to ship those events.

The summary statement: every layer assumes the network will fail, and the design measures the cost of that failure in *seconds the user notices*, not *seconds the connection was down*.
