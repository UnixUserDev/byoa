import { test } from "node:test"
import assert from "node:assert/strict"
import { sanitizeTitle, sanitizeTag, TitleError } from "../../src/memory/sanitize.ts"

test("sanitizeTitle rejects empty and punctuation-only input", () => {
  assert.throws(() => sanitizeTitle(""), TitleError)
  assert.throws(() => sanitizeTitle("   "), TitleError)
  assert.throws(() => sanitizeTitle("!!!"), TitleError)
})

test("sanitizeTitle cleans bad filename characters and collapses whitespace", () => {
  assert.equal(sanitizeTitle("a/b:c*d?e"), "a b c d e")
  assert.equal(sanitizeTitle("  hello   world  "), "hello world")
})

test("sanitizeTitle truncates on a word boundary", () => {
  const long = "one two three four five six seven eight nine ten eleven twelve"
  const out = sanitizeTitle(long, 20)
  assert.ok(out.length <= 20, out)
  assert.ok(!out.includes("  "), out)
  assert.equal(out, "one two three four")
})

test("sanitizeTitle refuses to cut a single long word in half", () => {
  assert.throws(() => sanitizeTitle("a".repeat(80), 20), TitleError)
})

test("sanitizeTag normalizes spaces and strips the hash", () => {
  assert.equal(sanitizeTag("memory/projects"), "memory/projects")
  assert.equal(sanitizeTag("#memory projects"), "memory-projects")
  assert.equal(sanitizeTag("   "), "memory")
})
