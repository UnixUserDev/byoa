import { test } from "node:test"
import assert from "node:assert/strict"
import { applyUi, initialState, reduce, type TuiState } from "../../src/adapters/tui/state.ts"
import type { AgentEvent } from "../../src/core/events.ts"

function feed(state: TuiState, events: AgentEvent[], start = 1_000): TuiState {
  let current = state
  let now = start
  for (const event of events) {
    current = reduce(current, event, now).state
    now += 10
  }
  return current
}

const session: AgentEvent = {
  t: "session.info",
  id: "ses_1",
  title: "demo",
  provider: "fake",
  model: "fake-1",
  tier: "normal",
  cwd: "/work",
}

test("a turn accumulates assistant text in one block", () => {
  const state = feed(initialState(), [
    session,
    { t: "turn.start", turn: 1 },
    { t: "text", delta: "hello " },
    { t: "text", delta: "world" },
  ])
  const assistants = state.blocks.filter((b) => b.kind === "assistant")
  assert.equal(assistants.length, 1)
  assert.equal(assistants[0]?.kind === "assistant" ? assistants[0].text : "", "hello world")
})

test("tool calls update in place and failures are counted", () => {
  const state = feed(initialState(), [
    session,
    { t: "turn.start", turn: 1 },
    { t: "tool.call", id: "c1", name: "fs_read", args: { path: "x" }, mutating: false },
    { t: "tool.result", id: "c1", name: "fs_read", ok: false, content: "nope" },
  ])
  const tools = state.blocks.filter((b) => b.kind === "tool")
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.kind === "tool" ? tools[0].ok : null, false)
  assert.ok(
    typeof (tools[0]?.kind === "tool" ? tools[0].startedAt : undefined) === "number",
    "a tool records when it started, so a pending one can show its age",
  )
  assert.equal(state.turn.tools, 1)
  assert.equal(state.turn.toolFails, 1)
})

test("a tool result with no recorded call is shown, not dropped", () => {
  const state = feed(initialState(), [
    { t: "turn.start", turn: 1 },
    { t: "tool.result", id: "orphan", name: "fs_read", ok: true, content: "x" },
  ])
  assert.equal(state.blocks.filter((b) => b.kind === "tool").length, 1)
})

test("per-step usage is summed for the turn, session totals come from the event", () => {
  const state = feed(initialState(), [
    { t: "turn.start", turn: 1 },
    { t: "usage", turnInput: 100, turnOutput: 10, sessionInput: 500, sessionOutput: 50 },
    { t: "usage", turnInput: 200, turnOutput: 20, sessionInput: 700, sessionOutput: 70 },
  ])
  assert.equal(state.turn.in, 300)
  assert.equal(state.turn.out, 30)
  assert.equal(state.usage.sessionIn, 700)
  assert.equal(state.usage.sessionOut, 70)
})

test("approval requests queue and turn.end clears them", () => {
  const withApproval = feed(initialState(), [
    { t: "approval.request", id: "a1", kind: "tool", detail: { name: "fs_write" } },
    { t: "approval.request", id: "a2", kind: "net", detail: { host: "x" } },
  ])
  assert.equal(withApproval.mode, "approval")
  assert.equal(withApproval.approvals.length, 2)

  const cleared = feed(withApproval, [{ t: "turn.end", turn: 1, finishReason: "stop" }])
  assert.equal(cleared.mode, "idle")
  assert.equal(cleared.approvals.length, 0)
})

test("a submit queued while running is replayed on turn.end exactly once", () => {
  const running = feed(initialState(), [{ t: "turn.start", turn: 1 }])
  const queued = applyUi(running, { t: "queueSubmit", text: "second" })
  const result = reduce({ ...queued, mode: "running" }, { t: "turn.end", turn: 1, finishReason: "stop" }, 2_000)
  const submit = result.effects.find((e) => e.t === "submit")
  assert.ok(submit && submit.t === "submit" && submit.text === "second")
  assert.equal(result.state.pendingSubmit, null)
})

test("errors become a notice block and are kept on the state", () => {
  const state = feed(initialState(), [{ t: "error", message: "boom", fatal: false }])
  const notice = state.blocks.find((b) => b.kind === "notice")
  assert.equal(notice?.kind === "notice" ? notice.level : "", "error")
  assert.equal(state.ui.lastError, "boom")
})

test("the transcript is capped so a long session cannot grow without bound", () => {
  const state = feed(initialState(), [
    { t: "turn.start", turn: 1 },
    ...Array.from({ length: 450 }, (_, i) => ({ t: "memory.recall" as const, query: `q${i}`, hits: [], tokens: 0 })),
  ])
  assert.ok(state.blocks.length <= 400, `blocks=${state.blocks.length}`)
})

test("sandbox degradation is reflected in the badge", () => {
  const state = feed(initialState(), [{ t: "sandbox.info", applied: false, degraded: true, reason: "no bwrap", policy: {} as never }])
  assert.equal(state.sandbox.badge, "sandbox degraded")
})

test("a call still in flight keeps ok null and its start time", () => {
  const state = feed(initialState(), [
    session,
    { t: "turn.start", turn: 1 },
    { t: "tool.call", id: "c9", name: "task", args: { task: "read the repo" }, mutating: false },
  ], 5_000)
  const tool = state.blocks.find((block) => block.kind === "tool")
  assert.equal(tool?.kind === "tool" ? tool.ok : "missing", null)
  assert.equal(tool?.kind === "tool" ? tool.name : "", "task")
  assert.equal(typeof (tool?.kind === "tool" ? tool.startedAt : undefined), "number")
})
