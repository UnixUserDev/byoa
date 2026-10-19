import { test } from "node:test"
import assert from "node:assert/strict"
import { parseToolArgs, repairJson } from "../../src/providers/accum.ts"

/**
 * `repairJson` sits directly on the untrusted path: it is handed whatever a model streamed into a
 * tool-call argument buffer, usually mid-token. It must never throw, and it must never turn a
 * mangled buffer into a *successful parse of the wrong thing*.
 */

test("a deeply nested truncation is closed all the way down", () => {
  const raw = '{"a":{"b":{"c":{"d":[1,[2,[3,'
  assert.equal(repairJson(raw), '{"a":{"b":{"c":{"d":[1,[2,[3]]]}}}}')
  assert.deepEqual(parseToolArgs(raw), { a: { b: { c: { d: [1, [2, [3]]] } } } })
})

test("a trailing comma is stripped at any nesting depth", () => {
  assert.equal(repairJson('{"nums":[1,2,3,'), '{"nums":[1,2,3]}')
  assert.deepEqual(parseToolArgs('{"nums":[1,2,3,'), { nums: [1, 2, 3] })
})

test("a string that ends on an escaped quote is closed correctly", () => {
  assert.equal(repairJson('{"a":"\\"'), '{"a":"\\""}')
  assert.deepEqual(parseToolArgs('{"a":"\\"'), { a: '"' })
})

test("a newline escape inside a partial string survives repair", () => {
  assert.deepEqual(parseToolArgs('{"a":"line\\nbreak'), { a: "line\nbreak" })
})

test("non-ASCII inside an unterminated string survives repair", () => {
  assert.deepEqual(parseToolArgs('{"emoji":"👍 unreal'), { emoji: "👍 unreal" })
})

test("repairJson never throws on hostile input", () => {
  const corpus = [
    "",
    "   ",
    "{{{{",
    "}}}}",
    "[[[[",
    "]]]]",
    '{"a":1},{"b":2}',
    "[1,2]extra",
    '{"a":tru',
    '\\',
    '""""',
    "\u0000",
    "{".repeat(10_000),
    '{"a":"' + "\\".repeat(100),
    String.fromCharCode(0xd800),
  ]
  for (const input of corpus) {
    assert.doesNotThrow(() => repairJson(input), `repairJson threw on ${JSON.stringify(input)}`)
  }
})

test("input that cannot be repaired is preserved, never silently emptied", () => {
  for (const input of ["{{{{", "}}}}", '{"a":1},{"b":2}', "[1,2]extra", '{"a":tru']) {
    const parsed = parseToolArgs(input) as { __unparsed?: string }
    assert.equal(parsed.__unparsed, input, `expected ${JSON.stringify(input)} to be preserved verbatim`)
  }
})
