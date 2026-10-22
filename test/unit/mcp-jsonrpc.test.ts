import { test } from "node:test"
import assert from "node:assert/strict"
import { JsonRpc, JsonRpcError } from "../../src/mcp/jsonrpc.ts"
import type { JsonRpcMessage } from "../../src/mcp/jsonrpc.ts"

function harness(): { rpc: JsonRpc; sent: JsonRpcMessage[] } {
  const sent: JsonRpcMessage[] = []
  return { rpc: new JsonRpc((message) => sent.push(message)), sent }
}

test("a request resolves when the matching id comes back", async () => {
  const { rpc, sent } = harness()
  const pending = rpc.request<string>("ping", { a: 1 })
  const id = (sent[0] as { id: number }).id
  rpc.handle({ jsonrpc: "2.0", id, result: "pong" })
  assert.equal(await pending, "pong")
  assert.equal(rpc.pendingCount, 0)
})

test("a response with no pending request is ignored, not thrown", () => {
  const { rpc } = harness()
  assert.doesNotThrow(() => rpc.handle({ jsonrpc: "2.0", id: 999, result: null }))
})

test("an error response rejects with the server's message and code", async () => {
  const { rpc, sent } = harness()
  const pending = rpc.request("explode")
  const id = (sent[0] as { id: number }).id
  rpc.handle({ jsonrpc: "2.0", id, error: { code: -32000, message: "nope" } })
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof JsonRpcError)
    assert.equal(error.message, "nope")
    assert.equal(error.code, -32000)
    return true
  })
})

test("notifications reach handlers without touching pending requests", async () => {
  const { rpc, sent } = harness()
  const seen: Array<[string, unknown]> = []
  rpc.onNotification((method, params) => seen.push([method, params]))
  const pending = rpc.request("work")
  rpc.handle({ jsonrpc: "2.0", method: "progress", params: { pct: 50 } })
  rpc.handle({ jsonrpc: "2.0", id: (sent[0] as { id: number }).id, result: "done" })
  assert.equal(await pending, "done")
  assert.deepEqual(seen, [["progress", { pct: 50 }]])
})

test("a throwing notification handler cannot break the reader", () => {
  const { rpc } = harness()
  rpc.onNotification(() => {
    throw new Error("listener bug")
  })
  assert.doesNotThrow(() => rpc.handle({ jsonrpc: "2.0", method: "noise" }))
})

test("rejectAll fails every in-flight request", async () => {
  const { rpc } = harness()
  const first = rpc.request("a")
  const second = rpc.request("b")
  rpc.rejectAll("server died")
  await assert.rejects(first, /server died/)
  await assert.rejects(second, /server died/)
  assert.equal(rpc.pendingCount, 0)
})

test("a server-initiated request gets method-not-found instead of silence", () => {
  const { rpc, sent } = harness()
  rpc.handle({ jsonrpc: "2.0", id: 7, method: "sampling/createMessage", params: {} })
  const reply = sent[0] as { id: number; error: { code: number } }
  assert.equal(reply.id, 7)
  assert.equal(reply.error.code, -32601)
})

test("an aborted request rejects and stops tracking the id", async () => {
  const { rpc } = harness()
  const controller = new AbortController()
  const pending = rpc.request("slow", undefined, controller.signal)
  controller.abort()
  await assert.rejects(pending, /aborted/)
  assert.equal(rpc.pendingCount, 0)
})
