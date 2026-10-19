import { test } from "node:test"
import assert from "node:assert/strict"
import { AnthropicProvider } from "../../src/providers/anthropic.ts"
import { sseResponse, data, makeRequest, collect } from "./helpers.ts"

function provider(chunks: string[], capture?: (body: unknown) => void, status = 200): AnthropicProvider {
  return new AnthropicProvider({
    id: "anthropic",
    baseUrl: "http://localhost:1",
    apiKey: "sk-ant-secret",
    fetchImpl: (_input, init) => {
      if (capture && init?.body) capture(JSON.parse(String(init.body)))
      return Promise.resolve(sseResponse(chunks, status))
    },
  })
}

test("streams text blocks and reads usage from message_start and message_delta", async () => {
  const events = await collect(
    provider([
      data({ type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 0 } } }),
      data({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
      data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
      data({ type: "content_block_stop", index: 0 }),
      data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
      data({ type: "message_stop" }),
    ]).stream(makeRequest()),
  )

  assert.equal(
    events.filter((event) => event.t === "text").map((event) => (event.t === "text" ? event.delta : "")).join(""),
    "Hello",
  )
  const inputs = events.filter((event) => event.t === "usage").map((event) => (event.t === "usage" ? event.input : 0))
  assert.ok(inputs.includes(20))
  assert.deepEqual(events.at(-1), { t: "done", finishReason: "stop" })
})

test("accumulates tool_use blocks and maps stop_reason tool_use", async () => {
  const events = await collect(
    provider([
      data({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
      data({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "shell" } }),
      data({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"comm' } }),
      data({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'and":"ls"}' } }),
      data({ type: "content_block_stop", index: 0 }),
      data({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    ]).stream(makeRequest()),
  )

  const start = events.find((event) => event.t === "tool.start")
  assert.ok(start && start.t === "tool.start")
  assert.equal(start.id, "toolu_1")

  const end = events.find((event) => event.t === "tool.end")
  assert.ok(end && end.t === "tool.end")
  assert.deepEqual(end.args, { command: "ls" })
  assert.deepEqual(events.at(-1), { t: "done", finishReason: "tool_calls" })
})

test("thinking deltas arrive as reasoning", async () => {
  const events = await collect(
    provider([
      data({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      data({ type: "message_stop" }),
    ]).stream(makeRequest()),
  )
  assert.equal(events.filter((event) => event.t === "reasoning").length, 1)
})

test("an error frame becomes an error event", async () => {
  const events = await collect(
    provider([data({ type: "error", error: { type: "overloaded_error", message: "overloaded" } })]).stream(makeRequest()),
  )
  const error = events.find((event) => event.t === "error")
  assert.ok(error && error.t === "error")
  assert.equal(error.message, "overloaded")
})

test("cache_control lands on the last stable system block only", async () => {
  let captured: { system?: Array<Record<string, unknown>> } = {}
  await collect(
    provider([data({ type: "message_stop" })], (body) => {
      captured = body as typeof captured
    }).stream(
      makeRequest({
        system: [
          { text: "persona", stable: true },
          { text: "safety", stable: true },
          { text: "memory digest", stable: false },
        ],
      }),
    ),
  )

  assert.equal(captured.system?.length, 3)
  assert.equal(captured.system?.[0]?.cache_control, undefined)
  assert.deepEqual(captured.system?.[1]?.cache_control, { type: "ephemeral" })
  assert.equal(captured.system?.[2]?.cache_control, undefined)
})

test("tool results are nested in a user turn and use input_schema", async () => {
  let captured: { messages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> } = {}
  await collect(
    provider([data({ type: "message_stop" })], (body) => {
      captured = body as typeof captured
    }).stream(
      makeRequest({
        tools: [{ name: "shell", description: "run a command", parameters: { type: "object" } }],
        messages: [
          { role: "user", content: "do it" },
          { role: "assistant", content: "", parts: [{ type: "tool-call", id: "toolu_1", name: "shell", args: { command: "ls" } }] },
          { role: "tool", parts: [{ type: "tool-result", id: "toolu_1", name: "shell", ok: false, content: "boom" }] },
        ],
      }),
    ),
  )

  const assistant = captured.messages?.find((message) => message.role === "assistant")
  const blocks = assistant?.content as Array<Record<string, unknown>>
  assert.equal(blocks[0]?.type, "tool_use")
  assert.equal(blocks[0]?.input && JSON.stringify(blocks[0].input), '{"command":"ls"}')

  const last = captured.messages?.at(-1)
  assert.equal(last?.role, "user")
  const results = last?.content as Array<Record<string, unknown>>
  assert.equal(results[0]?.type, "tool_result")
  assert.equal(results[0]?.tool_use_id, "toolu_1")
  assert.equal(results[0]?.is_error, true)

  assert.deepEqual(captured.tools?.[0]?.input_schema, { type: "object" })
})
