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

CREATE INDEX IF NOT EXISTS idx_turns_session_at ON turns(session_id, at);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS summary_up_to_count INT NOT NULL DEFAULT 0;
