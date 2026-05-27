# Gemini Live Reliability Lab

A backend reliability lab for proxying [Google's Gemini Live API](https://ai.google.dev/api/live) over a WebSocket with the four reliability features that matter most when a user is on poor cell signal:

1. **Heartbeat + reconnect** — bidirectional ping/pong and jittered exponential backoff on both legs
2. **Session resumption** — preserves conversation context across forced and unexpected disconnects using Gemini's `sessionResumption` mechanism
3. **Graceful degradation** — server-side bandwidth monitoring downgrades through `HD_VIDEO` → `LD_VIDEO` → `AUDIO_ONLY` → `PHOTO_MODE`
4. **Photo-based fallback path** — when streaming isn't viable, one round-trip REST call (image + audio + transcript context) gets the user an answer

A minimal HTML/JS test client exercises the backend end-to-end with built-in failure-injection toggles.

## Quickstart

```bash
npm install
cp .env.example .env
# put your key from https://aistudio.google.com/apikey into .env
npm run dev
```

Open <http://localhost:3000>.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start Fastify in watch mode with `tsx` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run compiled output |
| `npm test` | Run Vitest once |
| `npm run typecheck` | `tsc --noEmit` |

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/ws?sessionId=...` | WebSocket upgrade for streaming live mode. `sessionId` enables resumption across reconnect. |
| `POST` | `/fallback/photo` | Multipart: `photo` (required), `audio`, `text`, `sessionId`. Lower-bandwidth path via Gemini REST. |
| `GET` | `/health` | `{ok:true, sessions:N}` |
| `GET` | `/` | Serves the test client |

## Docs

- [`docs/architecture.md`](docs/architecture.md) — message flow and module map
- [`docs/reliability.md`](docs/reliability.md) — per-feature problem → solution
- [`docs/failure-modes.md`](docs/failure-modes.md) — failures × recovery × repro steps
- [`docs/testing.md`](docs/testing.md) — automated + manual injection
- [`docs/gemini-notes.md`](docs/gemini-notes.md) — Gemini Live behaviors used
- [`docs/application-answers.md`](docs/application-answers.md) — answers to the three job-posting questions

## Project Layout

```
src/
├── server.ts                # Fastify bootstrap
├── config.ts                # zod-validated env config
├── routes/{ws,fallback}.ts  # WS + REST routes
├── gemini/                  # liveClient.ts, liveTypes.ts, restClient.ts
├── session/                 # Session.ts, SessionManager.ts
├── reliability/             # heartbeat, bandwidthMonitor, degradation, reconnect
├── proxy/bridge.ts          # client WS ↔ Gemini WS wiring
└── util/{logger,ids}.ts
client/                      # Minimal HTML/JS test UI
tests/                       # Vitest specs + mockGemini fixture
docs/                        # Architecture + reliability writeups
```
