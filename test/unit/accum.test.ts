import { test } from "node:test"
import assert from "node:assert/strict"
import { parseToolArgs, repairJson, ToolCallAccumulator } from "../../src/providers/accum.ts"

test("valid JSON parses untouched", () => {
  assert.deepEqual(parseToolArgs('{"a":1}'), { a: 1 })
})

test("empty arguments become an empty object, not a crash", () => {
  assert.deepEqual(parseToolArgs(""), {})
  assert.deepEqual(parseToolArgs("   "), {})
})

test("truncated JSON is repaired rather than dropped", () => {
  assert.deepEqual(parseToolArgs('{"path":"/tmp/x"'), { path: "/tmp/x" })
  assert.deepEqual(parseToolArgs('{"a":{"b":[1,2'), { a: { b: [1, 2] } })
  assert.deepEqual(parseToolArgs('{"a":"unterminated'), { a: "unterminated" })
})

test("unrepairable garbage is preserved instead of throwing", () => {
  const result = parseToolArgs("not json at all") as { __unparsed?: string }
  assert.equal(result.__unparsed, "not json at all")
})

test("repairJson closes strings, brackets and a trailing comma", () => {
  assert.equal(repairJson('{"a":"b'), '{"a":"b"}')
  assert.equal(repairJson('{"a":1,'), '{"a":1}')
  assert.equal(repairJson('{"a":[1,'), '{"a":[1]}')
})

test("escaping inside strings does not confuse the repairer", () => {
  assert.equal(repairJson('{"a":"he said \\"hi\\""'), '{"a":"he said \\"hi\\""}')
})

test("the accumulator concatenates fragments in order", () => {
  const accumulator = new ToolCallAccumulator()
  accumulator.start(0, "call_1", "shell")
  accumulator.args(0, '{"comm')
  accumulator.args(0, 'and":"ls"}')
  const calls = accumulator.finish()
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.name, "shell")
  assert.deepEqual(calls[0]?.args, { command: "ls" })
})

test("a repeated start does not wipe streamed arguments", () => {
  const accumulator = new ToolCallAccumulator()
  accumulator.start(0, "call_1", "shell")
  accumulator.args(0, '{"command":')
  accumulator.start(0, "call_1", "shell")
  accumulator.args(0, '"ls"}')
  assert.deepEqual(accumulator.finish()[0]?.args, { command: "ls" })
})

test("a missing id gets synthesised so the tool result can be addressed", () => {
  const accumulator = new ToolCallAccumulator()
  accumulator.start(0, "", "shell")
  accumulator.setArgs(0, { command: "ls" })
  const [call] = accumulator.finish()
  assert.equal(call?.id, "call_0")
})

test("calls are ordered by stream index regardless of arrival order", () => {
  const accumulator = new ToolCallAccumulator()
  accumulator.start(1, "b", "second")
  accumulator.start(0, "a", "first")
  assert.deepEqual(
    accumulator.finish().map((call) => call.name),
    ["first", "second"],
  )
})

test("a nameless call is dropped rather than dispatched", () => {
  const accumulator = new ToolCallAccumulator()
  accumulator.start(0, "call_1", "")
  accumulator.setArgs(0, {})
  assert.equal(accumulator.finish().length, 0)
})
