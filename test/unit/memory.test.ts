import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ObsidianMemoryStore } from "../../src/memory/obsidian.ts"

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "byoa-mem-"))
  mkdirSync(join(dir, "memory"), { recursive: true })
  return dir
}

function writeRootNote(vault: string, title: string, body: string): string {
  const path = join(vault, "memory", `${title}.md`)
  writeFileSync(
    path,
    `---\ntags:\n  - memory/projects\ncreated: 2026-01-01T00:00:00\nsource: opencode\n---\n\n${body}\n\n[[Inbox]]\n`,
    "utf8",
  )
  return path
}

test("byoa only recalls its own namespaced notes", async () => {
  const vault = tempVault()
  writeRootNote(vault, "OpenCode note", "the secret vault fact about rusage")

  const byoa = new ObsidianMemoryStore(vault, "byoa")
  const saved = await byoa.remember({ text: "the byoa fact about rusage", title: "BYOA note", tag: "memory/projects", source: "agent" })
  assert.ok(saved.path.includes("/memory/byoa/"))

  const own = await byoa.recall({ query: "rusage", limit: 10, budgetTokens: 4000 })
  assert.equal(own.length, 1)
  assert.ok(own[0]?.path.includes("/memory/byoa/"))

  // The root note exists and contains the query, but byoa must not see it.
  const everything = await byoa.list()
  assert.ok(everything.every((note) => note.path.includes("/memory/byoa/")))
  byoa.close()

  // A generic reader with no namespace sees both.
  const all = new ObsidianMemoryStore(vault, "")
  const hits = await all.recall({ query: "rusage", limit: 10, budgetTokens: 4000 })
  assert.equal(hits.length, 2)
  all.close()

  rmSync(vault, { recursive: true, force: true })
})

test("remember writes frontmatter, source and the Inbox footer", async () => {
  const vault = tempVault()
  const store = new ObsidianMemoryStore(vault, "byoa")
  const saved = await store.remember({ text: "durable fact", title: "A durable fact", tag: "memory/projects", source: "agent" })
  assert.equal(saved.rejected, undefined)
  const text = readFileSync(saved.path, "utf8")
  assert.match(text, /tags:\n {2}- memory\/projects/)
  assert.match(text, /source: byoa/)
  assert.match(text, /\[\[Inbox\]\]/)
  store.close()
  rmSync(vault, { recursive: true, force: true })
})

test("the write gate rejects secrets and empty titles", async () => {
  const vault = tempVault()
  const store = new ObsidianMemoryStore(vault, "byoa")

  const secret = await store.remember({
    text: `key ${"sk-abcdefghij" + "klmnopqrstuvwxyz"}`,
    title: "A key",
    tag: "memory",
    source: "agent",
  })
  assert.match(secret.rejected ?? "", /secret/)

  const emptyTitle = await store.remember({ text: "fine", title: "!!!", tag: "memory", source: "agent" })
  assert.match(emptyTitle.rejected ?? "", /title/)

  const notes = await store.list()
  assert.equal(notes.length, 0, "nothing may be written on rejection")
  store.close()
  rmSync(vault, { recursive: true, force: true })
})

test("duplicate titles get a numeric suffix", async () => {
  const vault = tempVault()
  const store = new ObsidianMemoryStore(vault, "byoa")
  const first = await store.remember({ text: "one", title: "Same title", tag: "memory", source: "agent" })
  const second = await store.remember({ text: "two", title: "Same title", tag: "memory", source: "agent" })
  assert.ok(first.path.endsWith("Same title.md"))
  assert.ok(second.path.endsWith("Same title 2.md"))
  assert.ok(existsSync(second.path))
  store.close()
  rmSync(vault, { recursive: true, force: true })
})

test("forget only touches the namespace", async () => {
  const vault = tempVault()
  const root = writeRootNote(vault, "Shared name", "root body")
  const store = new ObsidianMemoryStore(vault, "byoa")
  await store.remember({ text: "own body", title: "Shared name", tag: "memory", source: "agent" })

  const removed = await store.forget("Shared name")
  assert.equal(removed, 1)
  assert.ok(existsSync(root), "a sibling note outside the namespace must survive")
  store.close()
  rmSync(vault, { recursive: true, force: true })
})
