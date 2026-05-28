# Durable session storage

The lab persists session metadata, transcript turns, and Gemini resumption handles
to Postgres so that a reconnecting client (or a restarted server) can pick up
exactly where the conversation left off. When `DATABASE_URL` is empty the
in-memory fallback is used and durability is process-lifetime only.

Same code, two backends:

- **Local Postgres** for development.
- **Supabase** for hosted demos (Supabase is Postgres + a managed control plane).

This lab uses the `pg` driver and a plain connection string. It does **not** use
`@supabase/supabase-js` — that client is designed for browser / Next.js apps
talking through PostgREST with anon keys + Row-Level-Security. For a server-side
Fastify app doing trusted CRUD against its own tables, the direct Postgres
driver is simpler, faster, and works against every Postgres host the same way.

## Schema

Two tables, applied automatically on boot from `src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resumption_handle  TEXT,
  mode               TEXT NOT NULL DEFAULT 'HD_VIDEO'
);

CREATE TABLE IF NOT EXISTS turns (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','model')),
  text        TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turns_session_at        ON turns(session_id, at);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity  ON sessions(last_activity);
```

## Local Postgres (Docker)

```bash
docker run --rm -d --name lab-pg \
  -e POSTGRES_PASSWORD=lab -e POSTGRES_DB=lab \
  -p 5432:5432 postgres:16-alpine
```

Then in `.env`:

```
DATABASE_URL=postgres://postgres:lab@localhost:5432/lab
```

Restart `npm run dev`. You should see `db.connected` on boot.

## Supabase

1. Create a project at <https://supabase.com>.
2. Set a database password during project creation (or in **Project Settings → Database**).
3. Grab the **connection string** from **Project Settings → Database → Connection string** and pick:
   - **Direct connection** (port `5432`) for development, or
   - **Transaction pooler** (port `6543`) for short-lived serverless functions.
4. Put it in `.env`:

   ```
   DATABASE_URL=postgresql://postgres:[YOUR-DB-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
   ```

   For the pooler:

   ```
   DATABASE_URL=postgresql://postgres.[PROJECT-REF]:[YOUR-DB-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
   ```

5. Restart the server. The schema is created on boot.

Note: the `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
pair from Supabase's quickstart is for the JS client. They aren't needed here —
the Postgres URL is.

## Verifying

After connecting a client and saying a few things:

```bash
psql "$DATABASE_URL" -c "SELECT id, last_activity FROM sessions;"
psql "$DATABASE_URL" -c "SELECT session_id, role, left(text, 50) FROM turns ORDER BY at;"
```

Stop the dev server, restart, reload the client tab (which keeps `sessionId` in
`localStorage`). The conversation continues — you'll see `session.loaded.from-db`
in the logs and the model's reply will reference the earlier turns.

## How the rehydrate path works

1. Client reconnects with `?sessionId=...` (stored in `localStorage`).
2. `SessionManager.getOrCreate(id)`:
   - If the session is already in memory, returns it.
   - Otherwise calls `store.load(id)`. On hit: rebuilds the `Session` with
     transcript + handle + last-activity; logs `session.loaded.from-db`.
3. `UpstreamSupervisor` opens a new Gemini WS. Before connect, it calls
   `Session.buildSeedContext(CONTEXT_REPLAY_TAIL_TURNS)` which returns:
   - `summary`: older turns flattened into a single string. Sent as
     `systemInstruction` in the setup message.
   - `replay`: the most recent N turns, sent as one `clientContent` batch with
     `turnComplete:false` right after `setupComplete`.
4. The model now has both long-range context (summary) and live working context
   (replay) without depending on Gemini's `sessionResumption` feature — which
   the current `gemini-2.5-flash-native-audio-*` family rejects.

## Operational notes

- Writes are fire-and-forget from the hot path (see
  `SessionManager.attachHooks`). A DB blip won't stall the live audio stream;
  worst case is the last turn or two aren't durable.
- Eviction runs every 5 minutes via `SessionManager.sweep`. Both the in-memory
  map and the `sessions` row are removed for anything past `SESSION_TTL_HOURS`.
  `ON DELETE CASCADE` on `turns(session_id)` drops the transcript with it.
- Tune `DB_POOL_MAX` for your hosting tier (Supabase free is 60 direct
  connections; the lab default of 10 leaves headroom).
