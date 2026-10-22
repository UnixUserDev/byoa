import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Agent } from "../../src/core/agent.ts"
import type { AgentEvent } from "../../src/core/events.ts"
import { FakeProvider } from "../../src/providers/fake.ts"
import type { FakeScript } from "../../src/providers/fake.ts"
import { createDefaultTools } from "../../src/tools/index.ts"
import { composeTools } from "../../src/tools/compose.ts"
import { loadPlugins } from "../../src/plugins/loader.ts"
import { McpManager } from "../../src/mcp/manager.ts"
import { SubagentRunner } from "../../src/agents/runner.ts"
import { createTaskTool } from "../../src/agents/task-tool.ts"
import { DEFAULT_POLICY } from "../../src/sandbox/policy.ts"
import { openDatabase } from "../../src/store/db.ts"
import { migrate } from "../../src/store/migrations.ts"
import { SqliteSessionStore } from "../../src/store/sessions.ts"

const POLICY = { ...DEFAULT_POLICY, enabled: false, strict: false }
const MCP_SERVER = fileURLToPath(new URL("../fixtures/fake-mcp-server.mjs", import.meta.url))

const PLUGIN = `
export default {
  id: "hello",
  name: "Hello",
  version: "1.0.0",
  tools: [
    {
      name: "shout",
      description: "shout the text back",
      mutating: false,
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async run(args) {
        return { ok: true, content: String(args.text).toUpperCase() }
      },
    },
  ],
  agents: [{ name: "greeter", prompt: "You greet people and nothing else." }],
}
`

function callStep(id: string, name: string, args: unknown): FakeScript[number] {
  return [
    { t: "tool.start", index: 0, id, name },
    { t: "tool.args", index: 0, jsonFragment: JSON.stringify(args) },
    { t: "tool.end", index: 0, id, name, args },
    { t: "usage", input: 20, output: 5 },
    { t: "done", finishReason: "tool_calls" },
  ]
}

function say(text: string): FakeScript[number] {
  return [{ t: "text", delta: text }, { t: "usage", input: 20, output: 5 }, { t: "done", finishReason: "stop" }]
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

test("a plugin tool, an MCP tool and a subagent all run in one real turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "byoa-ext-"))
  const db = openDatabase(":memory:")
  migrate(db)
  const store = new SqliteSessionStore(db)
  await writeFile(join(dir, "hello.ts"), PLUGIN)

  const pluginResult = await loadPlugins({ dir, enabled: ["hello"], log: () => {} })
  assert.equal(pluginResult.loaded.length, 1)

  const manager = new McpManager({
    servers: [
      {
        name: "fake",
        transport: "stdio",
        command: process.execPath,
        args: [MCP_SERVER],
        env: {},
        callTimeoutMs: 5_000,
      },
    ],
    log: () => {},
  })
  await manager.start()
  assert.deepEqual(manager.status().map((status) => status.ok), [true])

  const tools = createDefaultTools()
  composeTools(
    tools,
    [
      ...pluginResult.tools.map((tool) => ({ tool, source: "plugin" })),
      ...manager.tools().map((tool) => ({ tool, source: "mcp" })),
    ],
  )

  const provider = new FakeProvider({
    script: [
      callStep("a", "plugin__hello__shout", { text: "quiet" }),
      callStep("b", "mcp__fake__echo", { text: "over mcp" }),
      callStep("c", "task", { task: "say hi to the user", agent: "greeter" }),
      say("hi from the child"),
      say("everything ran"),
    ],
  })

  const runner = new SubagentRunner({
    store,
    provider,
    model: "fake-1",
    tier: "normal",
    tools,
    policy: POLICY,
    cwd: dir,
    approvalMode: "auto",
  })
  assert.equal(tools.get("task"), undefined, "the task tool is opt-in, not baked into the defaults")
  composeTools(tools, [
    {
      tool: createTaskTool({ runner, presets: pluginResult.agents, maxDepth: 2, maxSteps: 4 }),
      source: "subagents",
    },
  ])

  const session = store.create({ provider: "fake", model: "fake-1", tier: "normal", cwd: dir, policy: POLICY })
  const agent = new Agent({
    provider,
    model: "fake-1",
    tier: "normal",
    tools,
    policy: POLICY,
    cwd: dir,
    id: session.id,
    persistence: store.toPersistence(session.id),
    approvalMode: "auto",
  })

  try {
    const events = await drive(agent, "run every extension")

    const results = events.filter((event) => event.t === "tool.result")
    assert.deepEqual(results.map((event) => event.name), ["plugin__hello__shout", "mcp__fake__echo", "task"])
    assert.ok(results.every((event) => event.ok), `every tool succeeded: ${JSON.stringify(results)}`)

    // The plugin's tool ran, and its output reached the model, not just the log.
    assert.equal(results[0]?.content, "QUIET")

    // The MCP tool carried real arguments through a real child process.
    assert.match(results[1]?.content ?? "", /over mcp/)

    // The subagent answered and is recorded as a child of this session.
    assert.match(results[2]?.content ?? "", /hi from the child/)
    const children = store.listByParent(session.id)
    assert.equal(children.length, 1)
    assert.match(children[0]?.title ?? "", /greeter/)

    const finished = events.find((event) => event.t === "turn.end")
    assert.equal(finished?.t === "turn.end" ? finished.finishReason : null, "stop")
  } finally {
    await agent.dispose()
    await manager.close()
    for (const hook of pluginResult.teardown) await hook()
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("a broken plugin does not stop a session from starting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "byoa-ext-bad-"))
  const db = openDatabase(":memory:")
  migrate(db)
  const store = new SqliteSessionStore(db)
  await writeFile(join(dir, "broken.ts"), `throw new Error("kaboom")`)
  await writeFile(join(dir, "hello.ts"), PLUGIN)

  const pluginResult = await loadPlugins({ dir, enabled: ["broken", "hello"], log: () => {} })
  assert.equal(pluginResult.failed.length, 1)
  assert.equal(pluginResult.loaded.length, 1)

  const tools = composeTools(createDefaultTools(), pluginResult.tools.map((tool) => ({ tool, source: "plugin" })))
  assert.ok(tools.get("plugin__hello__shout"))

  const provider = new FakeProvider({ script: [say("still here")] })
  const session = store.create({ provider: "fake", model: "fake-1", tier: "normal", cwd: dir, policy: POLICY })
  const agent = new Agent({
    provider,
    model: "fake-1",
    tier: "normal",
    tools,
    policy: POLICY,
    cwd: dir,
    id: session.id,
    persistence: store.toPersistence(session.id),
  })
  try {
    const events = await drive(agent, "are you alive")
    assert.ok(events.some((event) => event.t === "text"))
  } finally {
    await agent.dispose()
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
