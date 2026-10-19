import { test } from "node:test"
import assert from "node:assert/strict"
import { OpenAiCompatibleProvider } from "../../src/providers/openai-compat.ts"
import { collect, data, makeRequest, sseResponse } from "./helpers.ts"

/**
 * Truncated and malformed streams. A local server that dies mid-frame, or a proxy that injects the
 * sentinel early, must end the turn cleanly rather than hang the agent or throw into the caller.
 */
function provider(chunks: string[]): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    id: "test",
    baseUrl: "http://localhost:1/v1",
    fetchImpl: () => Promise.resolve(sseResponse(chunks)),
  })
}

test("a [DONE] sentinel in the middle ends the stream and discards the rest", async () => {
  const events = await collect(
    provider([
      data({ choices: [{ delta: { content: "before" } }] }),
      data("[DONE]"),
      data({ choices: [{ delta: { content: "after" } }] }),
      data({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 9 } }),
    ]).stream(makeRequest()),
  )

  const text = events.filter((event) => event.t === "text").map((event) => (event.t === "text" ? event.delta : "")).join("")
  assert.equal(text, "before", "nothing after the sentinel should be emitted")
  assert.equal(events.filter((event) => event.t === "usage").length, 0, "usage after the sentinel must not arrive")
  assert.deepEqual(events.at(-1), { t: "done", finishReason: "stop" })
})

test("a stream that ends mid-frame still finishes the turn", async () => {
  const events = await collect(provider(['data: {"choices":[{"delta":{"content":"partial']).stream(makeRequest()))
  assert.deepEqual(events.at(-1), { t: "done", finishReason: "stop" })
  assert.equal(events.filter((event) => event.t === "error").length, 0)
})

test("a stream that simply ends without [DONE] finishes the turn", async () => {
  const events = await collect(provider([data({ choices: [{ delta: { content: "x" } }] })]).stream(makeRequest()))
  assert.equal(events.filter((event) => event.t === "text").length, 1)
  assert.deepEqual(events.at(-1), { t: "done", finishReason: "stop" })
})

test("an unparseable frame is skipped without killing the stream", async () => {
  const events = await collect(
    provider([data("not json at all"), data({ choices: [{ delta: { content: "ok" } }] })]).stream(makeRequest()),
  )
  assert.equal(events.filter((event) => event.t === "text").length, 1)
  assert.equal(events.filter((event) => event.t === "error").length, 0)
})

test("an empty 200 body yields a terminal done, not a hang", async () => {
  const events = await collect(provider([]).stream(makeRequest()))
  assert.deepEqual(events, [{ t: "done", finishReason: "stop" }])
})

test("a tool call whose arguments are truncated mid-JSON is repaired, not dropped", async () => {
  const events = await collect(
    provider([
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_t", function: { name: "fs_read" } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/tmp/x' } }] } }] }),
      data("[DONE]"),
    ]).stream(makeRequest()),
  )
  const end = events.find((event) => event.t === "tool.end")
  assert.ok(end && end.t === "tool.end")
  assert.deepEqual(end.args, { path: "/tmp/x" })
})

test("the stream is closed with a terminal done exactly once", async () => {
  const events = await collect(
    provider([
      data({ choices: [{ delta: { content: "a" } }] }),
      data({ choices: [{ delta: {}, finish_reason: "length" }] }),
      data("[DONE]"),
    ]).stream(makeRequest()),
  )
  assert.equal(events.filter((event) => event.t === "done").length, 1)
  assert.deepEqual(events.at(-1), { t: "done", finishReason: "length" })
})
