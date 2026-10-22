/**
 * The messages table is append-only on purpose.
 *
 * Provider prompt caching works on the request prefix: if history is rewritten (say, re-numbered
 * or edited in place) the prefix changes and the cache misses on every turn. Insert-only messages
 * with a monotonic sequence is what keeps a long session cheap.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  tier        TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  policy      TEXT NOT NULL,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  parent_id   TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  json        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC);
`
