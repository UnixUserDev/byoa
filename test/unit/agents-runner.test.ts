import { test } from "node:test"
import assert from "node:assert/strict"
import { SubagentRunner } from "../../src/agents/runner.ts"
import { createTaskTool } from "../../src/agents/task-tool.ts"
import { FakeProvider } from "../../src/providers/fake.ts"
import type { FakeScript } from "../../src/providers/fake.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"
import type { Tool } from "../../src/tools/types.ts"
import { DEFAULT_POLICY } from "../../src/sandbox/policy.ts"
import { openDatabase } from "../../src/store/db.ts"
import { migrate } from "../../src/store/migrations.ts"
import { SqliteSessionStore } from "../../src/store/sessions.ts"

const POLICY = { ...DEFAULT_POLICY, enabled: false, strict: false }

function probeTool(seen: string[] = []): Tool {
  return {
    name: "probe",
    description: "records that it ran",
    mutating: true,
    parameters: { type: "object", properties: {} },
    async run() {
      seen.push("probe")
      return { ok: true, content: "probed" }
    },
  }
}

function toolCallStep(name = "probe"): FakeScript[number] {
  return [
    { t: "tool.start", index: 0, id: "call-1", name },
    { t: "tool.args", index: 0, jsonFragment: "{}" },
    { t: "tool.end", index: 0, id: "call-1", name, args: {} },
    { t: "usage", input: 10, output: 5 },
    { t: "done", finishReason: "tool_calls" },
  ]
}

function textStep(text: string): FakeScript[number] {
  return [
    { t: "text", delta: text },
    { t: "usage", input: 10, output: 5 },
    { t: "done", finishReason: "stop" },
  ]
}

function harness(script: FakeScript, tools: ToolRegistry, approvalMode: "auto" | "ask" = "auto") {
  const db = openDatabase(":memory:")
  migrate(db)
  const store = new SqliteSessionStore(db)
  const provider = new FakeProvider({ script })
  const runner = new SubagentRunner({
    store,
    provider,
    model: "fake-1",
    tier: "normal",
    tools,
    policy: POLICY,
    cwd: process.cwd(),
    approvalMode,
  })
  return { db, store, runner }
}

const signal = (): AbortSignal => new AbortController().signal

test("a child run returns its final text and records a child session", async () => {
  const { db, store, runner } = harness([textStep("the answer is 42")], new ToolRegistry().register(probeTool()))
  try {
    const result = await runner.run(
      { name: "helper", prompt: "be helpful" },
      "work out the answer",
      { maxSteps: 4, maxDepth: 2 },
      { signal: signal(), depth: 0, parentSessionId: "ses_parent", requestApproval: async () => true },
    )
    assert.equal(result.ok, true)
    assert.equal(result.summary, "the answer is 42")
    assert.equal(result.finishReason, "stop")
    assert.equal(result.steps, 1)
    const child = store.get(result.childSessionId)
    assert.ok(child)
    assert.equal(child?.parentId, "ses_parent")
    assert.match(child?.title ?? "", /\[helper\] work out the answer/)
    assert.ok(store.getMessages(result.childSessionId).length >= 2, "the child transcript is persisted")
  } finally {
    db.close()
  }
})

test("the child can use tools and reports only the last answer segment", async () => {
  const seen: string[] = []
  const { db, runner } = harness(
    [toolCallStep(), textStep("done, the probe ran")],
    new ToolRegistry().register(probeTool(seen)),
  )
  try {
    const result = await runner.run(
      { name: "helper", prompt: "use tools" },
      "run the probe then answer",
      { maxSteps: 4, maxDepth: 2 },
      { signal: signal(), depth: 0, parentSessionId: "ses_parent", requestApproval: async () => true },
    )
    assert.deepEqual(seen, ["probe"])
    assert.equal(result.summary, "done, the probe ran")
    assert.equal(result.steps, 2)
  } finally {
    db.close()
  }
})

test("the step budget ends the child instead of running forever", async () => {
  const script: FakeScript = [toolCallStep(), toolCallStep(), toolCallStep()]
  const { db, runner } = harness(script, new ToolRegistry().register(probeTool()))
  try {
    const result = await runner.run(
      { name: "looper", prompt: "loop" },
      "keep going",
      { maxSteps: 2, maxDepth: 2 },
      { signal: signal(), depth: 0, parentSessionId: "ses_parent", requestApproval: async () => true },
    )
    assert.equal(result.finishReason, "max-steps")
    assert.equal(result.ok, false)
  } finally {
    db.close()
  }
})

test("cancelling the parent cancels the child", async () => {
  const controller = new AbortController()
  const provider = new FakeProvider({ script: [textStep("ignored")], delayMs: 5 })
  const db = openDatabase(":memory:")
  migrate(db)
  const store = new SqliteSessionStore(db)
  const runner = new SubagentRunner({
    store,
    provider,
    model: "fake-1",
    tier: "normal",
    tools: new ToolRegistry().register(probeTool()),
    policy: POLICY,
    cwd: process.cwd(),
    approvalMode: "auto",
  })
  try {
    const pending = runner.run(
      { name: "slow", prompt: "slow" },
      "do something slow",
      { maxSteps: 4, maxDepth: 2 },
      { signal: controller.signal, depth: 0, parentSessionId: "ses_parent", requestApproval: async () => true },
    )
    controller.abort()
    const result = await pending
    assert.equal(result.finishReason, "cancelled")
    assert.equal(result.ok, false)
  } finally {
    db.close()
  }
})

test("the output-token budget stops a chatty child", async () => {
  const { db, runner } = harness([textStep("a very long answer"), textStep("more")], new ToolRegistry().register(probeTool()))
  try {
    const result = await runner.run(
      { name: "chatty", prompt: "talk" },
      "talk a lot",
      { maxSteps: 4, maxDepth: 2, maxTokens: 1 },
      { signal: signal(), depth: 0, parentSessionId: "ses_parent", requestApproval: async () => true },
    )
    assert.equal(result.finishReason, "cancelled")
  } finally {
    db.close()
  }
})

test("an ask-mode child asks the parent's human, not nobody", async () => {
  const asked: unknown[] = []
  const seen: string[] = []
  const { db, runner } = harness(
    [toolCallStep(), textStep("denied, moving on")],
    new ToolRegistry().register(probeTool(seen)),
    "ask",
  )
  try {
    const result = await runner.run(
      { name: "cautious", prompt: "ask first" },
      "try the probe",
      { maxSteps: 4, maxDepth: 2 },
      {
        signal: signal(),
        depth: 0,
        parentSessionId: "ses_parent",
        requestApproval: async (request) => {
          asked.push(request)
          return false
        },
      },
    )
    assert.equal(asked.length, 1, "the child's approval request reached the parent channel")
    assert.deepEqual(seen, [], "a denied tool never ran")
    assert.equal(result.summary, "denied, moving on")
  } finally {
    db.close()
  }
})

function taskToolWith(runner: SubagentRunner, overrides: { maxDepth?: number; presets?: Array<{ name: string; prompt: string }> } = {}) {
  return createTaskTool({
    runner,
    presets: overrides.presets ?? [],
    maxDepth: overrides.maxDepth ?? 2,
    maxSteps: 3,
  })
}

const context = (depth: number) => ({
  cwd: process.cwd(),
  policy: POLICY,
  signal: new AbortController().signal,
  memory: null,
  sessionId: "ses_parent",
  depth,
  requestApproval: async () => true,
})

test("the task tool delegates and returns the summary", async () => {
  const { db, runner } = harness([textStep("delegated answer")], new ToolRegistry().register(probeTool()))
  try {
    const tool = taskToolWith(runner)
    const result = await tool.run({ task: "answer this" }, context(0))
    assert.equal(result.ok, true)
    assert.match(result.content, /delegated answer/)
    assert.ok(typeof result.meta?.childSessionId === "string")
  } finally {
    db.close()
  }
})

test("the task tool refuses past the depth ceiling without running anything", async () => {
  const { db, runner } = harness([textStep("should never happen")], new ToolRegistry().register(probeTool()))
  try {
    const tool = taskToolWith(runner, { maxDepth: 2 })
    const refused = await tool.run({ task: "go deeper" }, context(2))
    assert.equal(refused.ok, false)
    assert.match(refused.content, /refusing to delegate/)
    // Nothing was spawned: a refusal is decided before the runner is ever called.
    assert.equal(new SqliteSessionStore(db).list({ limit: 10 }).length, 0)
  } finally {
    db.close()
  }
})

test("an unknown preset is an error that lists what exists", async () => {
  const { db, runner } = harness([textStep("x")], new ToolRegistry().register(probeTool()))
  try {
    const tool = taskToolWith(runner, { presets: [{ name: "reviewer", prompt: "review" }] })
    const result = await tool.run({ task: "review this", agent: "ghost" }, context(0))
    assert.equal(result.ok, false)
    assert.match(result.content, /known: reviewer/)
  } finally {
    db.close()
  }
})

test("a named preset supplies the child's instructions", async () => {
  const prompts: string[] = []
  const provider = new FakeProvider({
    script: [
      (request) => {
        prompts.push(request.system.map((segment) => segment.text).join("\n"))
        return [{ t: "text", delta: "reviewed" }, { t: "done", finishReason: "stop" }]
      },
    ],
  })
  const db = openDatabase(":memory:")
  migrate(db)
  const store = new SqliteSessionStore(db)
  const runner = new SubagentRunner({
    store,
    provider,
    model: "fake-1",
    tier: "normal",
    tools: new ToolRegistry().register(probeTool()),
    policy: POLICY,
    cwd: process.cwd(),
    approvalMode: "auto",
  })
  try {
    const tool = createTaskTool({
      runner,
      presets: [{ name: "reviewer", prompt: "you review code and are rude about it" }],
      maxDepth: 2,
      maxSteps: 3,
    })
    const result = await tool.run({ task: "review x", agent: "reviewer" }, context(0))
    assert.equal(result.ok, true)
    assert.match(prompts[0] ?? "", /you review code and are rude about it/)
  } finally {
    db.close()
  }
})

test("a child at the depth ceiling is not offered the task tool", async () => {
  const offered: string[][] = []
  const provider = new FakeProvider({
    script: [
      (request) => {
        offered.push((request.tools ?? []).map((tool) => tool.name))
        return [{ t: "text", delta: "ok" }, { t: "done", finishReason: "stop" }]
      },
    ],
  })
  const db = openDatabase(":memory:")
  migrate(db)
  const store = new SqliteSessionStore(db)
  const tools = new ToolRegistry().register(probeTool())
  const runner = new SubagentRunner({
    store,
    provider,
    model: "fake-1",
    tier: "normal",
    tools,
    policy: POLICY,
    cwd: process.cwd(),
    approvalMode: "auto",
  })
  try {
    // Parent is at depth 0, the child runs at depth 1, which is the ceiling.
    await runner.run(
      { name: "leaf", prompt: "leaf" },
      "do it",
      { maxSteps: 2, maxDepth: 1 },
      { signal: signal(), depth: 0, parentSessionId: "ses_parent", requestApproval: async () => true },
    )
    assert.equal(offered.length, 1)
    assert.ok(!offered[0]?.includes("task"), "the task tool must not be offered at the ceiling")
    assert.ok(offered[0]?.includes("probe"), "the rest of the toolset is still there")
  } finally {
    db.close()
  }
})

test("the task tool rejects empty arguments before spawning anything", async () => {
  const { db, runner } = harness([textStep("x")], new ToolRegistry().register(probeTool()))
  try {
    const tool = taskToolWith(runner)
    assert.match(tool.validate?.({ task: "" }) ?? "", /task must be a non-empty string/)
    assert.equal(tool.validate?.({ task: "fine" }), null)
    const store = new SqliteSessionStore(db)
    assert.equal(store.list({ limit: 5 }).length, 0)
  } finally {
    db.close()
  }
})
