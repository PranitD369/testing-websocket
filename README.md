# Gemini Live Reliability Lab

A backend reliability lab for proxying [Google's Gemini Live API](https://ai.google.dev/api/live) over a WebSocket with the four reliability features that matter most when a user is on poor cell signal:

1. **Heartbeat + reconnect** — bidirectional ping/pong and jittered exponential backoff on both legs
2. **Session resumption** — preserves conversation context across forced and unexpected disconnects using Gemini's `sessionResumption` mechanism
3. **Graceful degradation** — server-side bandwidth monitoring downgrades through `HD_VIDEO` → `LD_VIDEO` → `AUDIO_ONLY` → `PHOTO_MODE`
4. **Photo-based fallback path** — when streaming isn't viable, one round-trip REST call (image + audio + transcript context) gets the user an answer

Two test clients ship with the lab:

- **`/`** — a minimal vanilla HTML/JS rig with failure-injection toggles (no build step, fastest smoke test)
- **`/app/`** — a React + TypeScript PWA (Vite + vite-plugin-pwa) that exercises the same backend with installability and offline shell. See [`docs/pwa.md`](docs/pwa.md).

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
| `GET` | `/health` | `{ok:true, sessions:N, db:true|false}` |
| `GET` | `/` | Vanilla HTML/JS test client |
| `GET` | `/app/` | React PWA test client (built from `web/`) |

## Docs

- [`docs/architecture.md`](docs/architecture.md) — message flow and module map
- [`docs/reliability.md`](docs/reliability.md) — per-feature problem → solution
- [`docs/failure-modes.md`](docs/failure-modes.md) — failures × recovery × repro steps
- [`docs/testing.md`](docs/testing.md) — automated + manual injection
- [`docs/gemini-notes.md`](docs/gemini-notes.md) — Gemini Live behaviors used
- [`docs/database.md`](docs/database.md) — Postgres / Supabase setup for durable session storage
- [`docs/pwa.md`](docs/pwa.md) — React PWA client: dev workflow, install, offline behavior
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
client/                      # Vanilla HTML/JS test UI (no build)
web/                         # React + TypeScript PWA (Vite + vite-plugin-pwa)
├── src/{components,hooks,lib}
├── public/{favicon.svg,icon-*.png}
└── scripts/generate-icons.mjs
tests/                       # Vitest specs + mockGemini fixture
docs/                        # Architecture + reliability writeups
```
