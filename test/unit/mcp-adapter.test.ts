import { test } from "node:test"
import assert from "node:assert/strict"
import { composeMcpServers, mcpTool, mcpToolName, renderContent } from "../../src/mcp/adapter.ts"
import type { McpCallResult, McpClientHandle, McpServerConfig, McpToolSchema } from "../../src/mcp/types.ts"
import type { ToolContext } from "../../src/tools/types.ts"

function fakeClient(result: McpCallResult, seen: unknown[] = []): McpClientHandle {
  return {
    name: "fake",
    async listTools(): Promise<McpToolSchema[]> {
      return []
    },
    async callTool(name, args) {
      seen.push({ name, args })
      return result
    },
    async close() {},
  }
}

const context: ToolContext = {
  cwd: "/tmp",
  policy: { enabled: false } as never,
  signal: new AbortController().signal,
  memory: null,
  requestApproval: async () => true,
}

const schema: McpToolSchema = { name: "do,thing", description: "does it", inputSchema: { type: "object" } }

test("tool names are namespaced and sanitized", () => {
  assert.equal(mcpToolName("my server", "do,thing"), "mcp__my_server__do_thing")
})

test("text content is joined", () => {
  const rendered = renderContent(
    [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ],
    1_000,
  )
  assert.deepEqual(rendered, { text: "one\ntwo", truncated: false })
})

test("images become a description because the model is text-only", () => {
  const rendered = renderContent([{ type: "image", data: "AAAA", mimeType: "image/png" }], 1_000)
  assert.match(rendered.text, /image image\/png/)
  assert.match(rendered.text, /not shown/)
})

test("resources keep their uri", () => {
  const rendered = renderContent([{ type: "resource", uri: "file:///x", text: "body" }], 1_000)
  assert.equal(rendered.text, "[resource file:///x] body")
})

test("oversized content is truncated with a visible marker", () => {
  const rendered = renderContent([{ type: "text", text: "y".repeat(500) }], 50)
  assert.equal(rendered.truncated, true)
  assert.match(rendered.text, /truncated at 50 characters/)
})

test("an isError result becomes ok:false", async () => {
  const tool = mcpTool(fakeClient({ content: [{ type: "text", text: "boom" }], isError: true }), schema, {
    serverName: "fake",
  })
  const result = await tool.run({}, context)
  assert.equal(result.ok, false)
  assert.equal(result.content, "boom")
})

test("an empty successful result says so instead of sending nothing", async () => {
  const tool = mcpTool(fakeClient({ content: [] }), schema, { serverName: "fake" })
  const result = await tool.run({}, context)
  assert.equal(result.ok, true)
  assert.equal(result.content, "(no content)")
})

test("a thrown call becomes a failed tool result, not an exception", async () => {
  const client: McpClientHandle = {
    name: "fake",
    async listTools() {
      return []
    },
    async callTool() {
      throw new Error("socket closed")
    },
    async close() {},
  }
  const tool = mcpTool(client, schema, { serverName: "fake" })
  const result = await tool.run({}, context)
  assert.equal(result.ok, false)
  assert.match(result.content, /socket closed/)
})

test("mutating can be turned off per server", () => {
  const tool = mcpTool(fakeClient({ content: [] }), schema, { serverName: "fake", mutating: false })
  assert.equal(tool.mutating, false)
})

test("config servers win over plugin servers field by field", () => {
  const fromPlugin: McpServerConfig[] = [
    { name: "notes", transport: "stdio", command: "plugin-cmd", args: ["a"] },
    { name: "only-plugin", transport: "http", url: "http://plugin" },
  ]
  const fromConfig: McpServerConfig[] = [{ name: "notes", transport: "stdio", command: "config-cmd" }]
  const merged = composeMcpServers(fromConfig, fromPlugin)
  assert.equal(merged.length, 2)
  const notes = merged.find((server) => server.name === "notes")
  assert.equal(notes?.command, "config-cmd")
  assert.deepEqual(notes?.args, ["a"], "unspecified fields survive from the plugin declaration")
  assert.ok(merged.some((server) => server.name === "only-plugin"))
})

test("a transport change does not drag the old transport's fields along", () => {
  const fromPlugin: McpServerConfig[] = [{ name: "srv", transport: "stdio", command: "old", args: ["a"], env: { X: "1" } }]
  const fromConfig: McpServerConfig[] = [{ name: "srv", transport: "http", url: "https://example.test/mcp" }]
  const merged = composeMcpServers(fromConfig, fromPlugin)[0]
  assert.equal(merged?.transport, "http")
  assert.equal(merged?.url, "https://example.test/mcp")
  assert.equal(merged?.command, undefined)
  assert.equal(merged?.args, undefined)
  assert.equal(merged?.env, undefined)
})
