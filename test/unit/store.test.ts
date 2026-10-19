import { test } from "node:test"
import assert from "node:assert/strict"
import { openDatabase } from "../../src/store/db.ts"
import { migrate, SCHEMA_VERSION } from "../../src/store/migrations.ts"
import { SqliteSessionStore } from "../../src/store/sessions.ts"
import { clonePolicy, DEFAULT_POLICY } from "../../src/sandbox/policy.ts"
import type { ProviderMessage } from "../../src/providers/types.ts"

function freshStore(): SqliteSessionStore {
  const db = openDatabase(":memory:")
  migrate(db)
  return new SqliteSessionStore(db)
}

const policy = mergePolicyForTest()
function mergePolicyForTest() {
  const base = clonePolicy(DEFAULT_POLICY)
  base.fs.rw = ["/tmp/work"]
  return base
}

function create(store: SqliteSessionStore) {
  return store.create({ provider: "fake", model: "fake-1", tier: "normal", cwd: "/tmp/work", policy })
}

test("migration is idempotent and stamps the schema version", () => {
  const db = openDatabase(":memory:")
  assert.equal(migrate(db), SCHEMA_VERSION)
  assert.equal(migrate(db), SCHEMA_VERSION)
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number }
  assert.equal(Number(row.user_version), SCHEMA_VERSION)
})

test("a session round-trips, policy included", () => {
  const store = freshStore()
  const created = create(store)
  const loaded = store.get(created.id)
  assert.ok(loaded)
  assert.equal(loaded.model, "fake-1")
  assert.deepEqual(loaded.policy.fs.rw, ["/tmp/work"])
  assert.deepEqual(loaded.policy.fs.ro, DEFAULT_POLICY.fs.ro)
})

test("messages are append-only with a monotonic sequence", () => {
  const store = freshStore()
  const session = create(store)
  const user: ProviderMessage = { role: "user", content: "first" }
  const assistant: ProviderMessage = { role: "assistant", content: "second", parts: [{ type: "text", text: "second" }] }
  const tool: ProviderMessage = { role: "tool", parts: [{ type: "tool-result", id: "c1", name: "shell", ok: true, content: "ok" }] }

  store.appendMessage(session.id, user)
  store.appendMessage(session.id, assistant)
  store.appendMessage(session.id, tool)

  const stored = store.getMessages(session.id)
  assert.equal(stored.length, 3)
  assert.deepEqual(stored.map((entry) => entry.role), ["user", "assistant", "tool"])
  assert.deepEqual(stored.map((entry) => entry.seq), [...stored.map((entry) => entry.seq)].sort((a, b) => a - b))
  assert.deepEqual(stored[2]?.message, tool)
})

test("the first user message names the session", () => {
  const store = freshStore()
  const session = create(store)
  assert.equal(store.get(session.id)?.title, "untitled")
  store.appendMessage(session.id, { role: "user", content: "fix the token estimator\nand add a test" })
  assert.equal(store.get(session.id)?.title, "fix the token estimator")
})

test("usage accumulates across turns", () => {
  const store = freshStore()
  const session = create(store)
  store.addUsage(session.id, 10, 5)
  store.addUsage(session.id, 3, 7)
  const loaded = store.get(session.id)
  assert.equal(loaded?.tokensIn, 13)
  assert.equal(loaded?.tokensOut, 12)
})

test("list is newest-first and match filters by title", () => {
  const store = freshStore()
  const first = create(store)
  store.appendMessage(first.id, { role: "user", content: "alpha task" })
  const second = create(store)
  store.appendMessage(second.id, { role: "user", content: "beta task" })

  const all = store.list()
  assert.equal(all.length, 2)
  assert.equal(all[0]?.id, second.id)

  const filtered = store.list({ match: "alpha" })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0]?.id, first.id)
})

test("deleting a session cascades to its messages", () => {
  const store = freshStore()
  const session = create(store)
  store.appendMessage(session.id, { role: "user", content: "gone soon" })
  store.delete(session.id)
  assert.equal(store.get(session.id), null)
  assert.equal(store.getMessages(session.id).length, 0)
})

test("getMessages can page from a sequence", () => {
  const store = freshStore()
  const session = create(store)
  for (const text of ["a", "b", "c"]) store.appendMessage(session.id, { role: "user", content: text })
  const stored = store.getMessages(session.id)
  const tail = store.getMessages(session.id, { fromSeq: stored[0]?.seq ?? 0 })
  assert.equal(tail.length, 2)
  assert.equal(tail[0]?.message.role, "user")
})
