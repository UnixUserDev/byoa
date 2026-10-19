import { test } from "node:test"
import assert from "node:assert/strict"
import { Agent } from "../../src/core/agent.ts"
import { FakeProvider } from "../../src/providers/fake.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"
import { clonePolicy, DEFAULT_POLICY } from "../../src/sandbox/policy.ts"
import type { AgentEvent } from "../../src/core/events.ts"
import type { Tool } from "../../src/tools/types.ts"

function makeAgent(provider: FakeProvider, tools = new ToolRegistry()): Agent {
  return new Agent({
    provider,
    model: "fake-1",
    tier: "normal",
    tools,
    policy: clonePolicy(DEFAULT_POLICY),
    cwd: process.cwd(),
  })
}

async function drive(agent: Agent, text: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  const finished = (async (): Promise<void> => {
    for await (const event of agent.events()) {
      events.push(event)
      if (event.t === "turn.end") break
    }
  })()
  agent.send({ t: "submit", text })
  await finished
  return events
}

function textOf(events: AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { t: "text" }> => event.t === "text")
    .map((event) => event.delta)
    .join("")
}

function finishOf(events: AgentEvent[]): string | undefined {
  const last = events.at(-1)
  return last?.t === "turn.end" ? last.finishReason : undefined
}

test("streams text and ends the turn cleanly", async () => {
  const agent = makeAgent(new FakeProvider())
  const events = await drive(agent, "hello")
  assert.equal(textOf(events), "fake: hello")
  assert.equal(finishOf(events), "stop")
  // The documented order: turn.start opens the turn, turn.end closes it, usage comes before the end.
  const startIndex = events.findIndex((event) => event.t === "turn.start")
  const firstTextIndex = events.findIndex((event) => event.t === "text")
  assert.ok(startIndex >= 0, "expected a turn.start event")
  assert.ok(firstTextIndex > startIndex, "text must come after turn.start")
  assert.equal(events.at(-1)?.t, "turn.end")
  assert.ok(events.some((event) => event.t === "usage"))
  await agent.dispose()
})

test("daily-driver tool call is fed back into the loop", async () => {
  const echo: Tool = {
    name: "echo",
    description: "echo the given text back",
    mutating: false,
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: (args) => {
      const text = (args as { text?: string }).text ?? ""
      return Promise.resolve({ ok: true, content: `echoed: ${text}` })
    },
  }
  const tools = new ToolRegistry().register(echo)

  const provider = new FakeProvider({
    script: [
      [
        { t: "tool.start", index: 0, id: "call_1", name: "echo" },
        { t: "tool.args", index: 0, jsonFragment: '{"text":' },
        { t: "tool.args", index: 0, jsonFragment: '"hi"}' },
        { t: "done", finishReason: "tool_calls" },
      ],
    ],
  })

  const agent = makeAgent(provider, tools)
  const events = await drive(agent, "use the tool")

  const call = events.find((event) => event.t === "tool.call")
  assert.ok(call, "expected a tool.call event")
  assert.equal(call.args && (call.args as { text: string }).text, "hi")

  const result = events.find((event) => event.t === "tool.result")
  assert.ok(result, "expected a tool.result event")
  assert.equal(result.content, "echoed: hi")
  assert.equal(result.ok, true)

  // Second step falls through to the fake provider's echo, proving the loop continued.
  assert.equal(textOf(events), "fake: use the tool")
  assert.equal(finishOf(events), "stop")
  await agent.dispose()
})

test("cancel interrupts a streaming turn", async () => {
  const agent = makeAgent(new FakeProvider({ delayMs: 25 }))
  const events: AgentEvent[] = []
  const finished = (async (): Promise<void> => {
    for await (const event of agent.events()) {
      events.push(event)
      if (event.t === "turn.end") break
    }
  })()

  agent.send({ t: "submit", text: "something long" })
  await new Promise((resolve) => setTimeout(resolve, 30))
  agent.send({ t: "cancel" })
  await finished

  assert.equal(finishOf(events), "cancelled")
  await agent.dispose()
})

test("unknown tools fail closed instead of throwing", async () => {
  const provider = new FakeProvider({
    script: [
      [
        { t: "tool.start", index: 0, id: "call_9", name: "not_a_tool" },
        { t: "done", finishReason: "tool_calls" },
      ],
    ],
  })
  const agent = makeAgent(provider)
  const events = await drive(agent, "call something that does not exist")
  const result = events.find((event) => event.t === "tool.result")
  assert.ok(result)
  assert.equal(result.ok, false)
  assert.match(result.content, /unknown tool/)
  await agent.dispose()
})
