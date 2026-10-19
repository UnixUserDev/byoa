import { test } from "node:test"
import assert from "node:assert/strict"
import { applyPatch } from "../../src/tools/patch.ts"

const ORIGINAL = ["one", "two", "three", "four", "five"].join("\n")

/**
 * Failure-path coverage for the diff applier. The model writes these patches by hand, so the
 * important properties are: never silently produce the wrong file, and never partially apply.
 */

test("applying the same patch twice fails closed rather than double-applying", () => {
  const patch = ["@@ -1,2 +1,2 @@", "-one", "+ONE", " two"].join("\n")
  const first = applyPatch(ORIGINAL, patch)
  assert.ok(first.ok)
  assert.equal(first.content, ["ONE", "two", "three", "four", "five"].join("\n"))

  const second = applyPatch(first.content, patch)
  assert.equal(second.ok, false, "the second application must not succeed")
})

test("overlapping hunks are refused instead of corrupting the file", () => {
  const patch = [
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "@@ -2,2 +2,2 @@",
    "-two",
    "+two",
    " three",
  ].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /does not match/)
})

test("a failing hunk anywhere means nothing is applied", () => {
  const patch = [
    "@@ -1,2 +1,2 @@",
    "-one",
    "+ONE",
    " two",
    "@@ -9,2 +9,2 @@",
    " nope",
    "-missing",
  ].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.equal(result.ok, false, "a multi-hunk patch must be all-or-nothing")
})

test("hunks listed out of order still land on the right lines", () => {
  const patch = [
    "@@ -4,2 +4,2 @@",
    " four",
    "-five",
    "+FIVE",
    "@@ -1,2 +1,2 @@",
    "-one",
    "+ONE",
    " two",
  ].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.ok(result.ok)
  assert.equal(result.content, ["ONE", "two", "three", "four", "FIVE"].join("\n"))
})

test("an earlier hunk that changes the line count does not knock later hunks off target", () => {
  const original = ["l1", "l2", "l3", "l4", "l5", "l6"].join("\n")
  const patch = ["@@ -1,2 +1,1 @@", " l1", "-l2", "@@ -5,2 +4,2 @@", " l5", "-l6", "+L6"].join("\n")
  const result = applyPatch(original, patch)
  assert.ok(result.ok)
  assert.equal(result.content, ["l1", "l3", "l4", "l5", "L6"].join("\n"))
})

test("an addition-only hunk anchored at the end of the file appends", () => {
  const patch = ["@@ -5,1 +5,2 @@", " five", "+six"].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.ok(result.ok)
  assert.equal(result.content, ["one", "two", "three", "four", "five", "six"].join("\n"))
})

test("an insertion in the middle lands between its context lines", () => {
  const patch = ["@@ -2,2 +2,3 @@", " two", "+inserted", " three"].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.ok(result.ok)
  assert.equal(result.content, ["one", "two", "inserted", "three", "four", "five"].join("\n"))
})

test("an empty file accepts a whole-file addition", () => {
  const result = applyPatch("", ["@@ -0,0 +1,1 @@", "+hello"].join("\n"))
  assert.ok(result.ok)
  assert.equal(result.content.trim(), "hello")
})

test("a context hunk against an empty file fails rather than inventing content", () => {
  const result = applyPatch("", ["@@ -1,1 +1,1 @@", "-x", "+y"].join("\n"))
  assert.equal(result.ok, false)
})

test("a hunk that only repeats context is a successful no-op", () => {
  const result = applyPatch(ORIGINAL, ["@@ -1,3 +1,3 @@", " one", " two", " three"].join("\n"))
  assert.ok(result.ok)
  assert.equal(result.content, ORIGINAL)
})

test("line counts in the header are not trusted over the hunk body", () => {
  // The model frequently gets oldCount wrong; the context lines are the real evidence.
  const patch = ["@@ -2,9 +2,3 @@", " two", "-three", "+THREE", " four"].join("\n")
  const result = applyPatch(ORIGINAL, patch)
  assert.ok(result.ok)
  assert.equal(result.content, ["one", "two", "THREE", "four", "five"].join("\n"))
})
