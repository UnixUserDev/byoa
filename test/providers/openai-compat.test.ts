import { test } from "node:test"
import assert from "node:assert/strict"
import { OpenAiCompatibleProvider } from "../../src/providers/openai-compat.ts"
import { sseResponse, data, makeRequest, collect } from "./helpers.ts"

function provider(chunks: string[], capture?: (body: unknown) => void, status = 200): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    id: "test",
    baseUrl: "http://localhost:1/v1",
    apiKey: "sk-secret",
    fetchImpl: (_input, init) => {
      if (capture && init?.body) capture(JSON.parse(String(init.body)))
      return Promise.resolve(sseResponse(chunks, status))
    },
  })
}

test("streams text, reports usage and finishes", async () => {
  const events = await collect(
    provider([
      data({ choices: [{ delta: { content: "Hel" } }] }),
      data({ choices: [{ delta: { content: "lo" } }] }),
      data({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 2 } }),
      data("[DONE]"),
    ]).stream(makeRequest()),
  )

  assert.equal(
    events.filter((event) => event.t === "text").map((event) => (event.t === "text" ? event.delta : "")).join(""),
    "Hello",
  )
  const usage = events.find((event) => event.t === "usage")
  assert.ok(usage && usage.t === "usage")
  assert.equal(usage.input, 11)
  assert.equal(usage.output, 2)
  assert.deepEqual(events.at(-1), { t: "done", finishReason: "stop" })
})

test("accumulates a tool call split across chunks", async () => {
  const events = await collect(
    provider([
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "shell", arguments: '{"comm' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] }),
      data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      data("[DONE]"),
    ]).stream(makeRequest()),
  )

  const start = events.find((event) => event.t === "tool.start")
  assert.ok(start && start.t === "tool.start")
  assert.equal(start.name, "shell")

  const end = events.find((event) => event.t === "tool.end")
  assert.ok(end && end.t === "tool.end")
  assert.equal(end.id, "call_a")
  assert.deepEqual(end.args, { command: "ls" })
  assert.deepEqual(events.at(-1), { t: "done", finishReason: "tool_calls" })
})

test("tolerates a local server that sends the whole call in one chunk with no id", async () => {
  const events = await collect(
    provider([
      data({ choices: [{ delta: { tool_calls: [{ function: { name: "shell", arguments: '{"command":"pwd"}' } }] } }] }),
      data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      data("[DONE]"),
    ]).stream(makeRequest()),
  )
  const end = events.find((event) => event.t === "tool.end")
  assert.ok(end && end.t === "tool.end")
  assert.equal(end.id, "call_0")
  assert.deepEqual(end.args, { command: "pwd" })
})

test("reasoning deltas come through as reasoning, not text", async () => {
  const events = await collect(
    provider([
      data({ choices: [{ delta: { reasoning_content: "thinking..." } }] }),
      data({ choices: [{ delta: { content: "answer" } }] }),
      data("[DONE]"),
    ]).stream(makeRequest()),
  )
  assert.equal(events.filter((event) => event.t === "reasoning").length, 1)
  assert.equal(events.filter((event) => event.t === "text").length, 1)
})

test("an HTTP error becomes a retryable error event, not a throw", async () => {
  const events = await collect(
    provider(["upstream exploded"], undefined, 503).stream(makeRequest()),
  )
  const error = events.find((event) => event.t === "error")
  assert.ok(error && error.t === "error")
  assert.equal(error.retryable, true)
  assert.equal(error.status, 503)
})

test("a 401 is not retryable", async () => {
  const events = await collect(provider(["no key"], undefined, 401).stream(makeRequest()))
  const error = events.find((event) => event.t === "error")
  assert.ok(error && error.t === "error")
  assert.equal(error.retryable, false)
})

test("the request body carries the system prompt, tools and stream options", async () => {
  let captured: { messages?: Array<Record<string, unknown>>; tools?: unknown[]; stream_options?: unknown } = {}
  await collect(
    provider([data("[DONE]")], (body) => {
      captured = body as typeof captured
    }).stream(
      makeRequest({
        tools: [{ name: "shell", description: "run a command", parameters: { type: "object" } }],
      }),
    ),
  )

  assert.equal(captured.messages?.[0]?.role, "system")
  assert.equal(captured.messages?.[0]?.content, "you are a test")
  assert.equal(captured.messages?.[1]?.role, "user")
  assert.equal(captured.tools?.length, 1)
  assert.deepEqual(captured.stream_options, { include_usage: true })
})

test("tool results are sent as their own role, addressed by tool_call_id", async () => {
  let captured: { messages?: Array<Record<string, unknown>> } = {}
  await collect(
    provider([data("[DONE]")], (body) => {
      captured = body as typeof captured
    }).stream(
      makeRequest({
        messages: [
          { role: "user", content: "do it" },
          {
            role: "assistant",
            content: "",
            parts: [{ type: "tool-call", id: "call_1", name: "shell", args: { command: "ls" } }],
          },
          { role: "tool", parts: [{ type: "tool-result", id: "call_1", name: "shell", ok: true, content: "file.txt" }] },
        ],
      }),
    ),
  )

  const assistant = captured.messages?.find((message) => message.role === "assistant")
  assert.equal(assistant?.content, null)
  assert.equal(Array.isArray(assistant?.tool_calls), true)

  const tool = captured.messages?.find((message) => message.role === "tool")
  assert.equal(tool?.tool_call_id, "call_1")
  assert.equal(tool?.content, "file.txt")
})
