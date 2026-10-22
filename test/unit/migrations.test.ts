import { test } from "node:test"
import assert from "node:assert/strict"
import { openDatabase } from "../../src/store/db.ts"
import { migrate, SCHEMA_VERSION } from "../../src/store/migrations.ts"
import { SqliteSessionStore } from "../../src/store/sessions.ts"
import { clonePolicy, DEFAULT_POLICY } from "../../src/sandbox/policy.ts"

/** The v1 schema, verbatim, without parent_id: what an existing install actually has on disk. */
const V1_SCHEMA = `
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
  tokens_out  INTEGER NOT NULL DEFAULT 0
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

function policy() {
  const base = clonePolicy(DEFAULT_POLICY)
  base.enabled = false
  base.strict = false
  base.fs.rw = ["/tmp/work"]
  return base
}

function columnNames(db: ReturnType<typeof openDatabase>, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
  return rows.map((row) => row.name)
}

test("a v1 database gains parent_id and keeps its rows", () => {
  const db = openDatabase(":memory:")
  db.exec(V1_SCHEMA)
  db.prepare("INSERT INTO sessions (id, title, created_at, updated_at, provider, model, tier, cwd, policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "ses_old",
    "an old session",
    1_000,
    2_000,
    "fake",
    "fake-1",
    "normal",
    "/tmp/work",
    JSON.stringify(policy()),
  )
  db.exec("PRAGMA user_version = 1")
  assert.equal(columnNames(db, "sessions").includes("parent_id"), false)

  assert.equal(migrate(db), SCHEMA_VERSION)
  assert.ok(columnNames(db, "sessions").includes("parent_id"))

  const store = new SqliteSessionStore(db)
  const old = store.get("ses_old")
  assert.equal(old?.title, "an old session")
  assert.equal(old?.parentId, null, "an existing row has no parent and must read as null, not undefined")

  const child = store.create({ provider: "fake", model: "fake-1", tier: "lite", cwd: "/tmp/work", policy: policy(), parentId: "ses_old" })
  assert.equal(child.parentId, "ses_old")
  assert.deepEqual(store.listByParent("ses_old").map((record) => record.id), [child.id])
})

test("migrating an already-current database is a no-op", () => {
  const db = openDatabase(":memory:")
  db.exec(V1_SCHEMA)
  db.exec("PRAGMA user_version = 1")
  assert.equal(migrate(db), SCHEMA_VERSION)
  assert.equal(migrate(db), SCHEMA_VERSION)
  assert.equal(migrate(db), SCHEMA_VERSION)
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number }
  assert.equal(Number(version.user_version), SCHEMA_VERSION)
})

test("a fresh database is created at the current version in one step", () => {
  const db = openDatabase(":memory:")
  assert.equal(migrate(db), SCHEMA_VERSION)
  assert.ok(columnNames(db, "sessions").includes("parent_id"))
  const indexes = db.prepare("PRAGMA index_list(sessions)").all() as unknown as { name: string }[]
  assert.ok(indexes.some((index) => index.name === "sessions_parent"))
})

test("a failed migration rolls back instead of half-applying", () => {
  const db = openDatabase(":memory:")
  db.exec(V1_SCHEMA)
  // Simulate a database whose sessions table is fine but whose index name is already taken by
  // something incompatible - the point is that a throw inside the step list leaves user_version
  // alone so the next open retries rather than pretending it worked.
  db.exec("PRAGMA user_version = 1")
  const broken = {
    prepare: db.prepare.bind(db),
    exec: ((sql: string) => {
      if (sql.includes("sessions_parent")) throw new Error("simulated failure")
      return db.exec(sql)
    }) as typeof db.exec,
  }
  assert.throws(() => migrate(broken as unknown as typeof db), /simulated failure/)
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number }
  assert.equal(Number(version.user_version), 1, "the version stamp must not advance on failure")
})
