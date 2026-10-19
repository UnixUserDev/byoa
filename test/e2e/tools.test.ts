import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent } from "../../src/core/agent.ts"
import { FakeProvider } from "../../src/providers/fake.ts"
import { createDefaultTools } from "../../src/tools/index.ts"
import { clonePolicy, DEFAULT_POLICY, mergePolicy } from "../../src/sandbox/policy.ts"
import { hasBubblewrap } from "../../src/sandbox/detect.ts"
import type { ProviderEvent } from "../../src/providers/types.ts"
import type { AgentEvent } from "../../src/core/events.ts"

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "byoa-ws-"))
  const policy = mergePolicy(clonePolicy(DEFAULT_POLICY), {
    // The tool tests are about tools, not isolation. Keep strict off so they still run on a box
    // where bubblewrap is missing (CI); the shell test skips explicitly in that case.
    strict: false,
    fs: { rw: [dir], ro: ["/usr", "/etc"], hidden: [] },
    env: { pass: ["PATH", "HOME", "LANG"], scrub: ["LD_LIBRARY_PATH"] },
  })
  return { dir, policy }
}

function callTool(name: string, args: Record<string, unknown>, id = "call_1"): ProviderEvent[] {
  return [
    { t: "tool.start", index: 0, id, name },
    { t: "tool.args", index: 0, jsonFragment: JSON.stringify(args) },
    { t: "tool.end", index: 0, id, name, args },
    { t: "done", finishReason: "tool_calls" },
  ]
}

async function run(
  dir: string,
  policy: ReturnType<typeof workspace>["policy"],
  script: ProviderEvent[][],
  prompt = "go",
): Promise<AgentEvent[]> {
  const agent = new Agent({
    provider: new FakeProvider({ script }),
    model: "fake-1",
    tier: "normal",
    tools: createDefaultTools(),
    policy,
    cwd: dir,
  })
  const events: AgentEvent[] = []
  const finished = (async (): Promise<void> => {
    for await (const event of agent.events()) {
      events.push(event)
      if (event.t === "turn.end") break
    }
  })()
  agent.send({ t: "submit", text: prompt })
  await finished
  await agent.dispose()
  return events
}

function resultOf(events: AgentEvent[]): { ok: boolean; content: string } | undefined {
  const found = events.filter((event) => event.t === "tool.result")
  const last = found.at(-1)
  return last?.t === "tool.result" ? { ok: last.ok, content: last.content } : undefined
}

test("fs_write then fs_read round-trips through the agent loop", async () => {
  const { dir, policy } = workspace()
  const script = [
    callTool("fs_write", { path: "notes/hello.txt", content: "hello from the sandbox" }),
    callTool("fs_read", { path: "notes/hello.txt" }, "call_2"),
  ]

  const events = await run(dir, policy, script)
  assert.equal(readFileSync(join(dir, "notes", "hello.txt"), "utf8"), "hello from the sandbox")
  const results = events.filter((event) => event.t === "tool.result")
  assert.equal(results.length, 2)
  assert.equal(results[0]?.ok, true)
  assert.match(results[1]?.t === "tool.result" ? results[1].content : "", /hello from the sandbox/)
})

test("fs_edit replaces an exact string and refuses an ambiguous one", async () => {
  const { dir, policy } = workspace()
  writeFileSync(join(dir, "code.ts"), "const a = 1\nconst b = 2\n")

  const ok = await run(dir, policy, [
    callTool("fs_edit", { path: "code.ts", oldString: "const a = 1", newString: "const a = 42" }),
  ])
  assert.equal(resultOf(ok)?.ok, true)
  assert.match(readFileSync(join(dir, "code.ts"), "utf8"), /const a = 42/)

  writeFileSync(join(dir, "dup.ts"), "x\nx\n")
  const ambiguous = await run(dir, policy, [
    callTool("fs_edit", { path: "dup.ts", oldString: "x", newString: "y" }),
  ])
  assert.equal(resultOf(ambiguous)?.ok, false)
  assert.match(resultOf(ambiguous)?.content ?? "", /appears 2 times/)

  const missing = await run(dir, policy, [
    callTool("fs_edit", { path: "dup.ts", oldString: "nope", newString: "y" }),
  ])
  assert.match(resultOf(missing)?.content ?? "", /not found/)
})

test("fs_patch applies a unified diff to a file on disk", async () => {
  const { dir, policy } = workspace()
  writeFileSync(join(dir, "app.txt"), "alpha\nbeta\ngamma\n")

  const events = await run(dir, policy, [
    callTool("fs_patch", {
      path: "app.txt",
      patch: ["@@ -1,3 +1,3 @@", " alpha", "-beta", "+BETA", " gamma"].join("\n"),
    }),
  ])
  assert.equal(resultOf(events)?.ok, true)
  assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "alpha\nBETA\ngamma\n")
})

test("a write outside the writable roots is refused by the tool itself", async () => {
  const { dir, policy } = workspace()
  const events = await run(dir, policy, [
    callTool("fs_write", { path: "/etc/byoa-should-not-exist", content: "nope" }),
  ])
  assert.equal(resultOf(events)?.ok, false)
  assert.match(resultOf(events)?.content ?? "", /outside the writable roots/)
  assert.equal(existsSync("/etc/byoa-should-not-exist"), false)
})

test("reading a missing file is a clean error, not a throw", async () => {
  const { dir, policy } = workspace()
  const events = await run(dir, policy, [callTool("fs_read", { path: "ghost.txt" })])
  assert.equal(resultOf(events)?.ok, false)
  assert.match(resultOf(events)?.content ?? "", /no such file/)
})

test("an unknown tool never reaches the filesystem", async () => {
  const { dir, policy } = workspace()
  const events = await run(dir, policy, [callTool("fs_rm_rf", { path: "/" })])
  assert.equal(resultOf(events)?.ok, false)
  assert.match(resultOf(events)?.content ?? "", /unknown tool/)
})

test("the shell tool runs a command and reports it as sandboxed", async (t) => {
  if (!hasBubblewrap()) return t.skip("bubblewrap is not available")
  const { dir, policy } = workspace()
  const events = await run(dir, policy, [callTool("shell", { command: "echo from-inside-shell" })])
  const result = resultOf(events)
  assert.equal(result?.ok, true)
  assert.match(result?.content ?? "", /from-inside-shell/)
})

test("a command denied by policy is refused with a reason", async () => {
  const { dir, policy } = workspace()
  const events = await run(dir, policy, [callTool("shell", { command: "sudo id" })])
  assert.equal(resultOf(events)?.ok, false)
  assert.match(resultOf(events)?.content ?? "", /denied by sandbox policy/)
})
