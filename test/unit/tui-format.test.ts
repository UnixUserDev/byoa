import { test } from "node:test"
import assert from "node:assert/strict"
import {
  compactCount,
  formatDuration,
  formatTps,
  radarFrame,
  splitStatus,
  statusLine,
  summarizeApproval,
  summarizeTool,
  tailPath,
  truncate,
} from "../../src/adapters/tui/format.ts"

test("compactCount keeps small numbers exact and compacts the rest", () => {
  assert.equal(compactCount(0), "0")
  assert.equal(compactCount(999), "999")
  assert.equal(compactCount(1000), "1.0k")
  assert.equal(compactCount(1234), "1.2k")
  assert.equal(compactCount(123_456), "123k")
  assert.equal(compactCount(1_500_000), "1.5M")
  assert.equal(compactCount(-5), "0")
  assert.equal(compactCount(Number.NaN), "0")
})

test("formatDuration is readable at every scale", () => {
  assert.equal(formatDuration(0), "0.0s")
  assert.equal(formatDuration(820), "0.8s")
  assert.equal(formatDuration(12_400), "12s")
  assert.equal(formatDuration(95_000), "1m35s")
})

test("formatTps refuses to invent a speed for very short turns", () => {
  assert.equal(formatTps(100, 200), "—")
  assert.equal(formatTps(0, 5000), "—")
  assert.equal(formatTps(320, 1000), "320 tok/s")
  assert.equal(formatTps(32, 1000), "32.0 tok/s")
})

test("truncate never splits a surrogate pair and respects the budget", () => {
  assert.equal(truncate("hello", 10), "hello")
  assert.equal(truncate("hello", 3), "he…")
  assert.equal(truncate("hello", 0), "")
  assert.equal(truncate("😀😀😀😀", 3), "😀😀…")
})

test("tailPath keeps the useful end of a path", () => {
  assert.equal(tailPath("/a/b/c", 40), "/a/b/c")
  assert.ok(tailPath("/home/user/projects/byoa/src/file.ts", 24).includes("file.ts"))
  assert.ok(tailPath("/home/user/projects/byoa/src/file.ts", 24).startsWith("…/"))
})

test("summarizeTool picks the identifying argument", () => {
  assert.equal(summarizeTool("fs_read", { path: "src/x.ts" }), "src/x.ts")
  assert.equal(summarizeTool("shell", { command: "ls   -la" }), "ls -la")
  assert.equal(summarizeTool("memory_recall", { query: "runtime" }), '"runtime"')
  assert.equal(summarizeTool("x", null), "")
})

test("summarizeApproval flattens and elides binary", () => {
  assert.equal(summarizeApproval({ a: 1 }), '{"a":1}')
  assert.ok(!summarizeApproval("a\nb").includes("\n"))
  assert.equal(summarizeApproval("A".repeat(200)), "[binary payload elided]")
})

test("the status line omits zero-value segments", () => {
  const empty = statusLine({
    turnIn: 0,
    turnOut: 0,
    elapsedMs: 0,
    tools: 0,
    toolFails: 0,
    memHits: 0,
    model: "fake/fake-1",
    tier: "normal",
    sandbox: "sandbox",
    width: 100,
  })
  assert.equal(empty.left, "ready")
  assert.equal(empty.right, "fake/fake-1 · normal · sandbox")

  const busy = statusLine({
    turnIn: 1234,
    turnOut: 321,
    elapsedMs: 2000,
    tools: 3,
    toolFails: 1,
    memHits: 2,
    model: "fake/fake-1",
    tier: "normal",
    sandbox: "sandbox",
    width: 120,
  })
  assert.match(busy.left, /1\.2k in/)
  assert.match(busy.left, /321 out/)
  assert.match(busy.left, /3 tools · 1 failed/)
  assert.match(busy.left, /2 mem/)
})

test("splitStatus keeps both ends inside the width", () => {
  const split = splitStatus({
    turnIn: 1_000_000,
    turnOut: 500_000,
    elapsedMs: 90_000,
    tools: 99,
    toolFails: 3,
    memHits: 9,
    model: "provider/a-very-long-model-name",
    tier: "large",
    sandbox: "sandbox degraded",
    width: 60,
  })
  assert.ok(split.left.length + split.right.length + 3 <= 60)
})

test("the radar rotates through one cell and never disappears", () => {
  const frames = [0, 1, 2, 3, 4, 5].map(radarFrame)
  assert.deepEqual(frames, ["⠁", "⠈", "⠐", "⠂", "⠁", "⠈"])
  // A render loop must not be able to produce an empty glyph, or the line shifts a column.
  for (const tick of [-3, -1, 1.7, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(radarFrame(tick).length, 1)
  }
})
