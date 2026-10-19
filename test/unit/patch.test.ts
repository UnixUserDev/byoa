import { test } from "node:test"
import assert from "node:assert/strict"
import { applyPatch, parseUnifiedDiff } from "../../src/tools/patch.ts"

const ORIGINAL = ["one", "two", "three", "four", "five"].join("\n")

test("applies a simple hunk", () => {
  const patch = ["@@ -2,3 +2,3 @@", " two", "-three", "+THREE", " four"].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.ok(result.ok)
  assert.equal(result.content, ["one", "two", "THREE", "four", "five"].join("\n"))
})

test("applies an addition without touching neighbours", () => {
  const patch = ["@@ -3,1 +3,2 @@", " three", "+three and a half"].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.ok(result.ok)
  assert.equal(result.content, ["one", "two", "three", "three and a half", "four", "five"].join("\n"))
})

test("applies a deletion", () => {
  const patch = ["@@ -1,2 +1,1 @@", " one", "-two"].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.ok(result.ok)
  assert.equal(result.content, ["one", "three", "four", "five"].join("\n"))
})

test("tolerates line numbers that are off by one or two", () => {
  const patch = ["@@ -4,3 +4,3 @@", " two", "-three", "+THREE", " four"].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.ok(result.ok)
  assert.match(result.content, /THREE/)
})

test("refuses a hunk whose context is not present", () => {
  const patch = ["@@ -1,3 +1,3 @@", " nonexistent", "-also missing", "+replacement"].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /does not match/)
})

test("a patch with no hunks is an error, not a silent no-op", () => {
  const parsed = parseUnifiedDiff("just some prose\nwith no hunks")
  assert.ok("error" in parsed)
})

test("ignores the --- and +++ file headers", () => {
  const patch = ["--- a/file.txt", "+++ b/file.txt", "@@ -1,1 +1,1 @@", "-one", "+ONE"].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.ok(result.ok)
  assert.match(result.content, /^ONE/)
})

test("applies multiple hunks against the right offsets", () => {
  const patch = [
    "@@ -1,2 +1,2 @@",
    "-one",
    "+ONE",
    " two",
    "@@ -4,2 +4,2 @@",
    " four",
    "-five",
    "+FIVE",
  ].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.ok(result.ok)
  assert.equal(result.content, ["ONE", "two", "three", "four", "FIVE"].join("\n"))
})

test("handles the no-newline-at-end marker", () => {
  const patch = ["@@ -5,1 +5,1 @@", "-five", "\\ No newline at end of file", "+FIVE"].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.ok(result.ok)
  assert.match(result.content, /FIVE$/)
})
