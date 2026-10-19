import { test } from "node:test"
import assert from "node:assert/strict"
import { openDatabase } from "../../src/store/db.ts"
import { migrate } from "../../src/store/migrations.ts"
import { SqliteSessionStore, titleFrom } from "../../src/store/sessions.ts"
import { clonePolicy, DEFAULT_POLICY } from "../../src/sandbox/policy.ts"

function freshStore(): SqliteSessionStore {
  const db = openDatabase(":memory:")
  migrate(db)
  return new SqliteSessionStore(db)
}

function create(store: SqliteSessionStore, title?: string) {
  return store.create({
    provider: "fake",
    model: "fake-1",
    tier: "normal",
    cwd: "/tmp/work",
    policy: clonePolicy(DEFAULT_POLICY),
    ...(title === undefined ? {} : { title }),
  })
}

test("getMessages with a limit returns the earliest N in sequence order", () => {
  const store = freshStore()
  const session = create(store)
  for (const text of ["a", "b", "c", "d", "e"]) store.appendMessage(session.id, { role: "user", content: text })

  const limited = store.getMessages(session.id, { limit: 3 })
  assert.equal(limited.length, 3)
  assert.deepEqual(
    limited.map((entry) => (entry.message.role === "user" ? entry.message.content : "")),
    ["a", "b", "c"],
  )
  assert.ok(limited.every((entry, index) => index === 0 || entry.seq > (limited[index - 1]?.seq ?? 0)))
})

test("getMessages with a limit of 0 returns nothing instead of everything", () => {
  const store = freshStore()
  const session = create(store)
  store.appendMessage(session.id, { role: "user", content: "a" })
  assert.equal(store.getMessages(session.id, { limit: 0 }).length, 0)
})

test("getMessages past the end of a session returns an empty list", () => {
  const store = freshStore()
  const session = create(store)
  store.appendMessage(session.id, { role: "user", content: "a" })
  assert.equal(store.getMessages(session.id, { fromSeq: 9_999 }).length, 0)
})

test("deleting an already-deleted session is a harmless no-op", () => {
  const store = freshStore()
  const session = create(store)
  store.appendMessage(session.id, { role: "user", content: "gone" })
  store.delete(session.id)
  assert.doesNotThrow(() => store.delete(session.id))
  assert.equal(store.get(session.id), null)
  assert.equal(store.getMessages(session.id).length, 0)
})

test("a rename survives a very long title without truncation or loss", () => {
  const store = freshStore()
  const session = create(store)
  const long = "t".repeat(10_000)
  store.rename(session.id, long)
  assert.equal(store.get(session.id)?.title, long)
})

test("interleaved appends keep a strictly increasing sequence and lose nothing", async () => {
  const store = freshStore()
  const session = create(store)
  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      Promise.resolve().then(() => store.appendMessage(session.id, { role: "user", content: `message ${index}` })),
    ),
  )

  const stored = store.getMessages(session.id)
  assert.equal(stored.length, 50)
  for (let index = 1; index < stored.length; index += 1) {
    assert.ok((stored[index]?.seq ?? 0) > (stored[index - 1]?.seq ?? 0), "sequence must be monotonic")
  }
  assert.equal(new Set(stored.map((entry) => entry.seq)).size, 50)
})

test("list is capped at twenty sessions by default", () => {
  const store = freshStore()
  const ids = Array.from({ length: 30 }, () => create(store).id)
  const listed = store.list()
  assert.equal(listed.length, 20)
  assert.equal(listed[0]?.id, ids.at(-1), "the most recent session must come first")
})

test("addUsage against an unknown session is a silent no-op", () => {
  const store = freshStore()
  assert.doesNotThrow(() => store.addUsage("ses_does_not_exist", 10, 10))
})

test("appending to an unknown session fails instead of creating an orphan message", () => {
  const store = freshStore()
  assert.throws(() => store.appendMessage("ses_does_not_exist", { role: "user", content: "hi" }))
  assert.equal(store.getMessages("ses_does_not_exist").length, 0, "no orphan row may be written")
})

test("titleFrom uses the first non-empty line, and falls back to untitled", () => {
  assert.equal(titleFrom("\n\n   \n"), "untitled")
  assert.equal(titleFrom("   "), "untitled")
  assert.equal(titleFrom("\n\n  real title  \nmore lines"), "real title")
})

test("titleFrom caps at the 60 character boundary", () => {
  const exact = "A".repeat(60)
  assert.equal(titleFrom(exact), exact, "exactly 60 characters must not be truncated")

  const tooLong = titleFrom("A".repeat(70))
  assert.equal(tooLong.length, 60)
  assert.ok(tooLong.endsWith("..."))
})
