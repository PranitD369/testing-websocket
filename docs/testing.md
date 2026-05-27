# Testing

## Automated (`npm test`)

Vitest covers the reliability primitives without burning real Gemini quota.

| File | What it verifies |
|---|---|
| `tests/heartbeat.test.ts` | Ping cadence, pong-driven RTT reporting, timeout firing exactly once, `stop()` actually stops |
| `tests/degradation.test.ts` | Threshold transitions (RTT), pong-miss escalation, 5-second upgrade hysteresis, `forceMode` bypass, video/audio forwarding gates |
| `tests/session.test.ts` | `SessionManager` reuse-by-id, id minting, handle persistence, transcript summary format |
| `tests/reconnect.test.ts` | `UpstreamSupervisor` handle persistence rules (`resumable:true` required), `mockGemini` fixture emits `sessionResumptionUpdate` and `goAway` correctly |

The `tests/fixtures/mockGemini.ts` fixture is a tiny in-process WS server that can be configured to:
- accept or refuse `setup`
- emit `sessionResumptionUpdate.newHandle` after a delay
- emit `goAway.timeLeft` after a delay
- close abruptly after a delay
- send arbitrary custom messages

Use it for any future test that needs a "real" Gemini-shaped peer.

## Manual end-to-end

1. Put a real key in `.env` (`GEMINI_API_KEY=...` from <https://aistudio.google.com/apikey>).
2. `npm run dev`, open <http://localhost:3000>.
3. Click **Connect**, then **Start camera + mic**, grant permissions.
4. Speak a question ("What is this part?") while pointing the camera at something.
5. You should hear a spoken reply within a few seconds.

### Reliability scenarios to walk through

#### A. Browser-leg heartbeat timeout
1. Connect, start a session, start media.
2. Toggle **stall pongs** in the client UI.
3. Within 25s, server logs `bridge.client.heartbeat-timeout`, closes the WS.
4. Client's `onclose` fires; jittered reconnect begins.
5. **Untoggle stall pongs** — within ~30s the client should reconnect and `hello` arrives with `resuming:true`.

#### B. Manual socket kill → session resumption
1. Connect, ask a question, get a reply.
2. Click **Kill socket**.
3. Client reconnects within ~250ms (first backoff slot is short).
4. Server logs `session.created.from-client-id` for the same id, opens Gemini with the stored handle, Gemini replays context.
5. Ask a follow-up question that depends on the previous turn — verify the model remembers.

#### C. Bandwidth degradation
1. In a terminal: `sudo tc qdisc add dev lo root netem delay 600ms` (sets RTT to ~600ms on loopback).
2. Within seconds, the server should emit `modeChange` to `AUDIO_ONLY`; the badge in the UI updates.
3. Lower it: `sudo tc qdisc change dev lo root netem delay 100ms`.
4. After 5 seconds of good metrics, mode upgrades back to `HD_VIDEO`. (Hysteresis prevents flapping.)
5. Clean up: `sudo tc qdisc del dev lo root`.

#### D. Photo fallback with transcript context
1. Have a live conversation: "What is this fitting?" → model answers.
2. Click **Force photo mode**.
3. Type "How do I tighten it without stripping the threads?" and click **Snap & ask**.
4. Verify the reply references the prior context (model knows you're talking about the same fitting).

#### E. Long session → `goAway`
1. Connect, start media, talk every ~30 seconds to keep the model "warm."
2. Wait 10+ minutes.
3. Logs should show `upstream.goAway` followed by `upstream.replacement.opening` and `upstream.replacement.ready.swap`.
4. Conversation continues without the client knowing anything happened.

## Cost-conscious test loop

- Real Gemini Live API consumes meaningful tokens on video. For repeat reliability work, prefer the mock fixture (`tests/fixtures/mockGemini.ts`) — it costs nothing and is deterministic.
- When testing against the real API, do short sessions and set `LOG_LEVEL=debug` so you can spot anything unexpected (e.g., the response modalities you actually got).
- Watch the dashboard at <https://aistudio.google.com> for token usage spikes after each test run.
