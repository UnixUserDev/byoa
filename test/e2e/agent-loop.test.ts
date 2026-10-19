import { test } from "node:test"
import assert from "node:assert/strict"
import { Agent, DEFAULT_MAX_STEPS } from "../../src/core/agent.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"
import { clonePolicy, DEFAULT_POLICY } from "../../src/sandbox/policy.ts"
import { withCapabilities } from "../../src/providers/types.ts"
import type { ModelCapabilities, Provider, ProviderEvent, ProviderRequest } from "../../src/providers/types.ts"
import type { Tool } from "../../src/tools/types.ts"
import type { AgentEvent } from "../../src/core/events.ts"
import type { ProviderMessage } from "../../src/providers/types.ts"

interface Harness {
  provider: Provider
  calls: () => number
  requests: () => ProviderRequest[]
}

/**
 * A provider that replays a scripted list of events per call and records a *snapshot* of each
 * request. The snapshot matters: the agent hands the provider its own live history array, so a
 * captured reference would keep growing after the call and make assertions lie.
 */
function scripted(script: ProviderEvent[][]): Harness {
  const requests: ProviderRequest[] = []
  const provider: Provider = {
    id: "scripted",
    dialect: "openai",
    capabilities: (): ModelCapabilities => withCapabilities(),
    listModels: () => Promise.resolve([]),
    stream: async function* (request: ProviderRequest) {
      requests.push({ ...request, messages: [...request.messages] })
      const events = script[requests.length - 1] ?? [{ t: "done", finishReason: "stop" }]
      for (const event of events) yield event
    },
  }
  return { provider, calls: () => requests.length, requests: () => requests }
}

function throwing(message: string): Harness {
  const requests: ProviderRequest[] = []
  const provider: Provider = {
    id: "throwing",
    dialect: "openai",
    capabilities: (): ModelCapabilities => withCapabilities(),
    listModels: () => Promise.resolve([]),
    stream: async function* (request: ProviderRequest): AsyncGenerator<ProviderEvent> {
      requests.push({ ...request, messages: [...request.messages] })
      throw new Error(message)
    },
  }
  return { provider, calls: () => requests.length, requests: () => requests }
}

const noopTool = (name: string): Tool => ({
  name,
  description: name,
  mutating: false,
  parameters: { type: "object" },
  run: () => Promise.resolve({ ok: true, content: "ok" }),
})

const callStep = (name: string, id: string): ProviderEvent[] => [
  { t: "tool.start", index: 0, id, name },
  { t: "tool.args", index: 0, jsonFragment: "{}" },
  { t: "done", finishReason: "tool_calls" },
]

const finalStep: ProviderEvent[] = [
  { t: "text", delta: "finished" },
  { t: "done", finishReason: "stop" },
]

function makeAgent(provider: Provider, tools: ToolRegistry, options: { maxSteps?: number; history?: ProviderMessage[]; tier?: "lite" | "normal" | "large" } = {}): Agent {
  return new Agent({
    provider,
    model: "fake-1",
    tier: options.tier ?? "normal",
    tools,
    policy: clonePolicy(DEFAULT_POLICY),
    cwd: "/tmp",
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.history === undefined ? {} : { initialHistory: options.history }),
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

function finishOf(events: AgentEvent[]): string | undefined {
  const last = events.at(-1)
  return last?.t === "turn.end" ? last.finishReason : undefined
}

function countOf(events: AgentEvent[], type: AgentEvent["t"]): number {
  return events.filter((event) => event.t === type).length
}

test("DEFAULT_MAX_STEPS is the documented twenty-four", () => {
  assert.equal(DEFAULT_MAX_STEPS, 24)
})

test("a model that never stops calling tools is cut off at maxSteps", async () => {
  // Every step asks for another tool call, so nothing but the step budget can end this turn.
  const harness = scripted([callStep("noop", "c1"), callStep("noop", "c2"), callStep("noop", "c3")])
  const tools = new ToolRegistry().register(noopTool("noop"))
  const agent = makeAgent(harness.provider, tools, { maxSteps: 3 })

  const events = await drive(agent, "loop forever")

  assert.equal(finishOf(events), "max-steps")
  assert.equal(harness.calls(), 3, "the provider must be called once per step and no more")
  assert.equal(countOf(events, "tool.call"), 3)
  assert.equal(countOf(events, "tool.result"), 3)
  assert.equal(events.at(-1)?.t, "turn.end")
  await agent.dispose()
})

test("a single-step budget still reports max-steps rather than hanging", async () => {
  const harness = scripted([callStep("noop", "c1"), finalStep])
  const agent = makeAgent(harness.provider, new ToolRegistry().register(noopTool("noop")), { maxSteps: 1 })

  const events = await drive(agent, "one step only")

  assert.equal(finishOf(events), "max-steps")
  assert.equal(harness.calls(), 1)
  await agent.dispose()
})

test("a provider that yields nothing ends the turn instead of hanging", async () => {
  const provider: Provider = {
    id: "silent",
    dialect: "openai",
    capabilities: () => withCapabilities(),
    listModels: () => Promise.resolve([]),
    stream: async function* (): AsyncGenerator<ProviderEvent> {},
  }
  const agent = makeAgent(provider, new ToolRegistry())

  const events = await drive(agent, "anyone home")

  assert.equal(finishOf(events), "stop")
  assert.equal(countOf(events, "text"), 0)
  assert.equal(countOf(events, "tool.result"), 0)
  assert.equal(countOf(events, "error"), 0)
  await agent.dispose()
})

test("a provider that throws ends the turn with an error reason", async () => {
  const harness = throwing("provider exploded")
  const agent = makeAgent(harness.provider, new ToolRegistry())

  const events = await drive(agent, "go")

  assert.equal(finishOf(events), "error")
  const errors = events.filter((event) => event.t === "error")
  assert.equal(errors.length, 1)
  assert.match(errors[0]?.t === "error" ? errors[0].message : "", /provider exploded/)
  assert.equal(errors[0]?.t === "error" ? errors[0].fatal : true, false, "a provider failure must not be fatal to the session")
  await agent.dispose()
})

test("cancelling while a tool is still running ends the turn as cancelled", async () => {
  let started: () => void = () => {}
  const hasStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  const slowing: Tool = {
    name: "slow",
    description: "blocks until released",
    mutating: false,
    parameters: { type: "object" },
    run: async () => {
      started()
      await gate
      return { ok: true, content: "finished anyway" }
    },
  }

  const harness = scripted([callStep("slow", "c1"), finalStep])
  const agent = makeAgent(harness.provider, new ToolRegistry().register(slowing), { maxSteps: 5 })

  const events: AgentEvent[] = []
  const finished = (async (): Promise<void> => {
    for await (const event of agent.events()) {
      events.push(event)
      if (event.t === "turn.end") break
    }
  })()

  agent.send({ t: "submit", text: "start something slow" })
  await hasStarted
  agent.send({ t: "cancel" })
  release()
  await finished

  assert.equal(finishOf(events), "cancelled")
  assert.equal(harness.calls(), 1, "no further provider call may happen after a cancel")
  await agent.dispose()
})

test("a tool that throws becomes an ok:false result and the loop continues", async () => {
  const exploding: Tool = {
    name: "boom",
    description: "always throws",
    mutating: false,
    parameters: { type: "object" },
    run: () => {
      throw new Error("kaboom")
    },
  }

  const harness = scripted([callStep("boom", "c1"), finalStep])
  const agent = makeAgent(harness.provider, new ToolRegistry().register(exploding))

  const events = await drive(agent, "go")

  const results = events.filter((event) => event.t === "tool.result")
  assert.equal(results.length, 1)
  assert.equal(results[0]?.t === "tool.result" ? results[0].ok : true, false)
  assert.equal(results[0]?.t === "tool.result" ? results[0].content : "", "kaboom")
  assert.equal(finishOf(events), "stop", "the turn must survive a throwing tool")
  assert.equal(harness.calls(), 2)
  await agent.dispose()
})

test("repeated tool calls are each fed back into the next request", async () => {
  const harness = scripted([
    callStep("noop", "c1"),
    callStep("noop", "c2"),
    callStep("noop", "c3"),
    callStep("noop", "c4"),
    callStep("noop", "c5"),
    finalStep,
  ])
  const agent = makeAgent(harness.provider, new ToolRegistry().register(noopTool("noop")))

  const events = await drive(agent, "chain five tools")

  assert.equal(finishOf(events), "stop")
  assert.equal(harness.calls(), 6, "five tool steps plus the final answer")
  assert.equal(countOf(events, "tool.result"), 5)

  const final = harness.requests().at(-1)
  const roles = (final?.messages ?? []).map((message) => message.role)
  assert.equal(roles[0], "user")
  assert.equal(roles.filter((role) => role === "tool").length, 5)
  assert.equal(roles.filter((role) => role === "assistant").length, 5)
  await agent.dispose()
})

test("a second submit while a turn is running is refused", async () => {
  const harness = scripted([finalStep, finalStep])
  const agent = makeAgent(harness.provider, new ToolRegistry())

  const events: AgentEvent[] = []
  const finished = (async (): Promise<void> => {
    for await (const event of agent.events()) {
      events.push(event)
      if (event.t === "turn.end") break
    }
  })()

  agent.send({ t: "submit", text: "first" })
  agent.send({ t: "submit", text: "second" })
  await finished

  assert.equal(countOf(events, "turn.start"), 1, "the second submit must not start a turn")
  const errors = events.filter((event) => event.t === "error")
  assert.equal(errors.length, 1)
  assert.match(errors[0]?.t === "error" ? errors[0].message : "", /already running/)
  await agent.dispose()
})

test("a mutating tool is gated on approval and runs only when allowed", async () => {
  const ran = { count: 0 }
  const writer: Tool = {
    name: "writer",
    description: "a mutating tool",
    mutating: true,
    parameters: { type: "object" },
    run: () => {
      ran.count += 1
      return Promise.resolve({ ok: true, content: "wrote it" })
    },
  }
  const harness = scripted([callStep("writer", "c1"), finalStep])
  const agent = new Agent({
    provider: harness.provider,
    model: "fake-1",
    tier: "normal",
    tools: new ToolRegistry().register(writer),
    policy: clonePolicy(DEFAULT_POLICY),
    cwd: "/tmp",
    approvalMode: "ask",
  })

  const events: AgentEvent[] = []
  const finished = (async (): Promise<void> => {
    for await (const event of agent.events()) {
      events.push(event)
      if (event.t === "approval.request") agent.send({ t: "approve", id: event.id, allow: true })
      if (event.t === "turn.end") break
    }
  })()
  agent.send({ t: "submit", text: "go" })
  await finished

  assert.equal(countOf(events, "approval.request"), 1)
  assert.equal(ran.count, 1, "an approved mutating tool must run exactly once")
  const result = events.find((event) => event.t === "tool.result")
  assert.equal(result?.t === "tool.result" ? result.ok : false, true)
  await agent.dispose()
})

test("denying approval means the mutating tool never runs", async () => {
  const ran = { count: 0 }
  const writer: Tool = {
    name: "writer",
    description: "a mutating tool",
    mutating: true,
    parameters: { type: "object" },
    run: () => {
      ran.count += 1
      return Promise.resolve({ ok: true, content: "wrote it" })
    },
  }
  const harness = scripted([callStep("writer", "c1"), finalStep])
  const agent = new Agent({
    provider: harness.provider,
    model: "fake-1",
    tier: "normal",
    tools: new ToolRegistry().register(writer),
    policy: clonePolicy(DEFAULT_POLICY),
    cwd: "/tmp",
    approvalMode: "ask",
  })

  const events: AgentEvent[] = []
  const finished = (async (): Promise<void> => {
    for await (const event of agent.events()) {
      events.push(event)
      if (event.t === "approval.request") agent.send({ t: "approve", id: event.id, allow: false })
      if (event.t === "turn.end") break
    }
  })()
  agent.send({ t: "submit", text: "go" })
  await finished

  assert.equal(ran.count, 0, "a denied tool must not touch the filesystem")
  const result = events.find((event) => event.t === "tool.result")
  assert.equal(result?.t === "tool.result" ? result.ok : true, false)
  assert.equal(result?.t === "tool.result" ? result.content : "", "denied by user")
  assert.equal(finishOf(events), "stop", "a denial is not an error")
  await agent.dispose()
})

test("cancelling while an approval is pending fails closed", async () => {
  const ran = { count: 0 }
  const writer: Tool = {
    name: "writer",
    description: "a mutating tool",
    mutating: true,
    parameters: { type: "object" },
    run: () => {
      ran.count += 1
      return Promise.resolve({ ok: true, content: "wrote it" })
    },
  }
  const harness = scripted([callStep("writer", "c1"), finalStep])
  const agent = new Agent({
    provider: harness.provider,
    model: "fake-1",
    tier: "normal",
    tools: new ToolRegistry().register(writer),
    policy: clonePolicy(DEFAULT_POLICY),
    cwd: "/tmp",
    approvalMode: "ask",
  })

  const events: AgentEvent[] = []
  const finished = (async (): Promise<void> => {
    for await (const event of agent.events()) {
      events.push(event)
      if (event.t === "approval.request") agent.send({ t: "cancel" })
      if (event.t === "turn.end") break
    }
  })()
  agent.send({ t: "submit", text: "go" })
  await finished

  assert.equal(ran.count, 0, "a cancelled approval must not run the tool")
  assert.equal(finishOf(events), "cancelled")
  await agent.dispose()
})

test("a tool result larger than the tier ceiling is truncated and flagged", async () => {
  const huge: Tool = {
    name: "huge",
    description: "returns far more than the tier budget",
    mutating: false,
    parameters: { type: "object" },
    run: () => Promise.resolve({ ok: true, content: Array.from({ length: 5_000 }, (_, n) => `line ${n}`).join("\n") }),
  }
  const harness = scripted([callStep("huge", "c1"), finalStep])
  const agent = makeAgent(harness.provider, new ToolRegistry().register(huge), { tier: "lite" })

  const events = await drive(agent, "read something enormous")

  const result = events.find((event) => event.t === "tool.result")
  assert.ok(result?.t === "tool.result")
  assert.equal(result.truncated, true, "an oversized result must be flagged as truncated")
  assert.match(result.content, /characters omitted/)
  assert.ok(result.content.length < 20_000, "the capped result must not be the whole file")
  await agent.dispose()
})

test("a trimmed history still starts with a user turn and never orphans a tool result", async () => {
  const history: ProviderMessage[] = []
  for (let index = 0; index < 20; index += 1) {
    history.push({ role: "user", content: `question ${index} `.repeat(80) })
    history.push({
      role: "assistant",
      content: "",
      parts: [{ type: "tool-call", id: `call_${index}`, name: "noop", args: {} }],
    })
    history.push({
      role: "tool",
      parts: [{ type: "tool-result", id: `call_${index}`, name: "noop", ok: true, content: "r".repeat(800) }],
    })
    history.push({ role: "assistant", content: `answer ${index} `.repeat(30), parts: [{ type: "text", text: `answer ${index}` }] })
  }

  const harness = scripted([finalStep])
  const agent = makeAgent(harness.provider, new ToolRegistry(), { tier: "lite", history: history })

  await drive(agent, "next question here")

  const sent = harness.requests().at(0)?.messages ?? []
  assert.ok(sent.length > 0)
  assert.equal(sent[0]?.role, "user", "a request must never begin mid-exchange")

  const seenToolCalls = new Set<string>()
  for (const message of sent) {
    if (message.role === "assistant") {
      for (const part of message.parts) if (part.type === "tool-call") seenToolCalls.add(part.id)
    }
    if (message.role === "tool") {
      for (const part of message.parts) {
        assert.ok(seenToolCalls.has(part.id), `tool result ${part.id} has no matching tool call in the request`)
      }
    }
  }
  await agent.dispose()
})
