import { test } from "node:test"
import assert from "node:assert/strict"
import { HttpTransport } from "../../src/mcp/http.ts"

interface Seen {
  method: string
  headers: Record<string, string>
  body: unknown
}

function jsonFetch(result: (method: string, params: unknown) => unknown, seen: Seen[] = []): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method: string; params?: unknown }
    seen.push({ method: String(init?.method ?? "POST"), headers, body })
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: result(body.method, body.params) }), {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
    })
  }) as typeof fetch
}

test("an http server handshakes and calls tools", async () => {
  const seen: Seen[] = []
  const transport = new HttpTransport({
    url: "http://localhost:1/mcp",
    fetchImpl: jsonFetch((method, params) => {
      if (method === "initialize") return { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x" } }
      if (method === "tools/list") return { tools: [{ name: "echo", description: "d", inputSchema: { type: "object" } }] }
      if (method === "tools/call") return { content: [{ type: "text", text: JSON.stringify(params) }] }
      throw new Error(`unexpected ${method}`)
    }, seen),
  })

  await transport.request("initialize", {})
  const tools = await transport.request<{ tools: Array<{ name: string }> }>("tools/list", {})
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["echo"])

  const called = await transport.request<{ content: Array<{ text: string }> }>("tools/call", {
    name: "echo",
    arguments: { a: 1 },
  })
  assert.deepEqual(JSON.parse(called.content[0]?.text ?? "{}"), { name: "echo", arguments: { a: 1 } })
  assert.ok(seen.some((entry) => entry.headers["mcp-session-id"] === "session-1"))
  await transport.close()
})

test("an SSE reply is parsed", async () => {
  const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })}\n\n`
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body))
          controller.close()
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch

  const transport = new HttpTransport({ url: "http://localhost:1/mcp", fetchImpl })
  const result = await transport.request<{ tools: unknown[] }>("tools/list", {})
  assert.deepEqual(result.tools, [])
  await transport.close()
})

test("an http error status becomes a readable error", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 503, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch
  const transport = new HttpTransport({ url: "http://localhost:1/mcp", fetchImpl })
  await assert.rejects(transport.request("tools/list", {}), /mcp http 503: nope/)
  await transport.close()
})

test("a json-rpc error is surfaced, not swallowed", async () => {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "bad request" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
  const transport = new HttpTransport({ url: "http://localhost:1/mcp", fetchImpl })
  await assert.rejects(transport.request("tools/list", {}), /bad request/)
  await transport.close()
})

test("close ends a session it was given", async () => {
  let deleted = false
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      deleted = true
      return new Response(null, { status: 204 })
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "session-9" },
    })
  }) as typeof fetch

  const transport = new HttpTransport({ url: "http://localhost:1/mcp", fetchImpl })
  await transport.request("initialize", {})
  await transport.close()
  assert.equal(deleted, true)
})

test("an oversized reply is refused during the read, not after it", async () => {
  const fetchImpl = (async () =>
    new Response("x".repeat(5_000), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch
  const transport = new HttpTransport({ url: "http://localhost:1/mcp", fetchImpl, maxReplyBytes: 1_000 })
  await assert.rejects(transport.request("tools/list", {}), /exceeded 1000 bytes/)
  await transport.close()
})

test("config headers cannot override the protocol headers", async () => {
  let seen: Record<string, string> = {}
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen = (init?.headers ?? {}) as Record<string, string>
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  const transport = new HttpTransport({
    url: "http://localhost:1/mcp",
    fetchImpl,
    headers: { "content-type": "text/plain", "x-custom": "1" },
  })
  await transport.request("initialize", {})
  assert.equal(seen["content-type"], "application/json")
  assert.equal(seen["x-custom"], "1")
  await transport.close()
})
