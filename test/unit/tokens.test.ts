import { test } from "node:test"
import assert from "node:assert/strict"
import { estimateMessages, estimateTokens, truncateToTokens } from "../../src/core/tokens.ts"

test("estimateTokens is zero for empty input but not for whitespace", () => {
  assert.equal(estimateTokens(""), 0)
  assert.ok(estimateTokens("   ") > 0, "whitespace still costs a token")
  assert.ok(estimateTokens("\n\n") > 0)
})

test("estimateTokens grows with length", () => {
  const small = estimateTokens("hello world")
  const big = estimateTokens("hello world ".repeat(1_000))
  assert.ok(big > small * 100, `expected the estimate to scale, got ${small} -> ${big}`)
})

test("estimateTokens is pessimistic on a huge string", () => {
  const estimate = estimateTokens("a".repeat(100_000))
  assert.ok(estimate >= 25_000, `expected >=25000 for 100k ascii chars, got ${estimate}`)
})

test("CJK costs at least one token per character", () => {
  const cjk = "你好世界"
  assert.ok(estimateTokens(cjk) >= cjk.length, `CJK should cost >=${cjk.length}, got ${estimateTokens(cjk)}`)
})

test("emoji are not free", () => {
  const emoji = "👍🎉😀"
  assert.ok(estimateTokens(emoji) >= 4, `emoji should cost more than a word, got ${estimateTokens(emoji)}`)
})

test("estimateMessages ignores content that is absent or not a string", () => {
  assert.equal(estimateMessages([]), 0)
  assert.equal(estimateMessages([{}]), 0)
  assert.equal(estimateMessages([{ content: null }]), 0)
  assert.ok(estimateMessages([{ content: "hello there" }]) > 0)
})

test("estimateMessages weighs tool results and streamed tool arguments in parts", () => {
  const toolResult: Array<{ content?: unknown; parts?: unknown }> = [
    { parts: [{ type: "tool-result", id: "c1", name: "shell", ok: true, content: "x".repeat(4_000) }] },
  ]
  const weighed = estimateMessages(toolResult)
  assert.ok(weighed >= 1_000, `a 4000-char tool result must not weigh zero, got ${weighed}`)

  const toolCall: Array<{ content?: unknown; parts?: unknown }> = [
    { parts: [{ type: "tool-call", id: "c1", name: "fs_write", args: { blob: "y".repeat(4_000) } }] },
  ]
  const argsWeighed = estimateMessages(toolCall)
  assert.ok(argsWeighed >= 1_000, `tool-call arguments must not weigh zero, got ${argsWeighed}`)
})

test("truncateToTokens leaves a short string alone", () => {
  const result = truncateToTokens("short text", 1_000)
  assert.equal(result.truncated, false)
  assert.equal(result.text, "short text")
})

test("truncateToTokens at exactly the estimate does not truncate", () => {
  const text = "abcdabcdabcdabcd"
  const exact = estimateTokens(text)
  const result = truncateToTokens(text, exact)
  assert.equal(result.truncated, false)
  assert.equal(result.text, text)
})

test("truncateToTokens with maxTokens 0 truncates instead of crashing", () => {
  const result = truncateToTokens("line one\nline two", 0)
  assert.equal(result.truncated, true)
  assert.match(result.text, /\[\.\.\. truncated, \d+ characters omitted\]/)
})

test("truncateToTokens cuts on a line boundary and keeps a prefix of the original", () => {
  const text = Array.from({ length: 50 }, (_, index) => `line number ${index} with some padding`).join("\n")
  const result = truncateToTokens(text, 20)
  assert.equal(result.truncated, true)

  const marker = "\n[... truncated,"
  const markerIndex = result.text.indexOf(marker)
  assert.ok(markerIndex > 0, "expected the truncation marker to be present")
  const kept = result.text.slice(0, markerIndex)
  assert.ok(text.startsWith(kept), "the kept content must be a prefix of the original")
  assert.ok(kept.includes("\n"), "an available line boundary should have been used")
  assert.ok(!kept.includes("line number 40"), "the tail must be gone")
})
