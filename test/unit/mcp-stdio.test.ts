import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { McpClient } from "../../src/mcp/client.ts"
import type { McpServerConfig } from "../../src/mcp/types.ts"
import { mcpTool } from "../../src/mcp/adapter.ts"

const SERVER = fileURLToPath(new URL("../fixtures/fake-mcp-server.mjs", import.meta.url))

function config(env: Record<string, string> = {}, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "fake",
    transport: "stdio",
    command: process.execPath,
    args: [SERVER],
    env,
    callTimeoutMs: 5_000,
    ...overrides,
  }
}

test("a stdio server handshakes and lists its tools", async () => {
  const client = new McpClient(config())
  try {
    const tools = await client.listTools()
    assert.deepEqual(tools.map((tool) => tool.name), ["echo"])
    assert.equal(tools[0]?.description, "fake echo tool")
    assert.equal((tools[0]?.inputSchema as { type?: string }).type, "object")
  } finally {
    await client.close()
  }
})

test("a tool call round-trips its arguments", async () => {
  const client = new McpClient(config())
  try {
    const result = await client.callTool("echo", { text: "hello" })
    assert.equal(result.isError, undefined)
    assert.equal(result.content[0]?.type, "text")
    assert.deepEqual(JSON.parse(result.content[0]?.text ?? "{}"), { tool: "echo", args: { text: "hello" } })
  } finally {
    await client.close()
  }
})

test("a server that reports isError is not silently treated as success", async () => {
  const client = new McpClient(config())
  try {
    const result = await client.callTool("echo", { fail: true })
    assert.equal(result.isError, true)
  } finally {
    await client.close()
  }
})

test("Content-Length framing is tolerated as well as newline framing", async () => {
  const client = new McpClient(config({ FAKE_MCP_FRAMING: "lsp" }))
  try {
    const tools = await client.listTools()
    assert.deepEqual(tools.map((tool) => tool.name), ["echo"])
    const result = await client.callTool("echo", { text: "framed" })
    assert.match(result.content[0]?.text ?? "", /framed/)
  } finally {
    await client.close()
  }
})

test("a paginated tool list is followed to the end", async () => {
  const client = new McpClient(config({ FAKE_MCP_PAGINATE: "1", FAKE_MCP_TOOLS: "one,two" }))
  try {
    const tools = await client.listTools()
    assert.deepEqual(tools.map((tool) => tool.name), ["one", "two"])
  } finally {
    await client.close()
  }
})

test("a hung call times out instead of hanging the turn", async () => {
  const client = new McpClient(config({ FAKE_MCP_HANG: "call" }, { callTimeoutMs: 300 }))
  try {
    await assert.rejects(client.callTool("echo", {}), /aborted|timed out/i)
  } finally {
    await client.close()
  }
})

test("a server that dies mid-call fails the call, not the process", async () => {
  const client = new McpClient(config({ FAKE_MCP_DIE: "call" }))
  try {
    await assert.rejects(client.callTool("echo", {}), /server/i)
  } finally {
    await client.close()
  }
})

test("an unwritable server command fails start with a readable reason", async () => {
  const client = new McpClient(config({}, { command: "/definitely/not/a/binary" }))
  await assert.rejects(client.listTools(), /mcp fake: initialize failed/)
  await client.close()
})

test("the adapter namespaces the tool and caps a huge result", async () => {
  const client = new McpClient(config())
  try {
    const schemas = await client.listTools()
    const tool = mcpTool(client, schemas[0] as (typeof schemas)[number], { serverName: "fake", maxResultChars: 100 })
    assert.equal(tool.name, "mcp__fake__echo")
    assert.equal(tool.mutating, true, "mcp tools are behind the approval gate by default")
    const result = await tool.run(
      { size: 5_000 },
      {
        cwd: process.cwd(),
        policy: { enabled: false } as never,
        signal: new AbortController().signal,
        memory: null,
        requestApproval: async () => true,
      },
    )
    assert.equal(result.ok, true)
    assert.ok(result.content.length < 200)
    assert.match(result.content, /truncated at 100 characters/)
  } finally {
    await client.close()
  }
})

test("the child environment is allowlisted and its dangerous knobs cannot be overridden", async () => {
  const { childEnv } = await import("../../src/mcp/stdio.ts")
  const env = childEnv({
    PATH: "/evil/bin",
    LD_PRELOAD: "/tmp/takeover.so",
    NODE_OPTIONS: "--require /tmp/takeover.js",
    PYTHONPATH: "/tmp",
    MY_API_TOKEN: "allowed-because-named",
  })
  assert.equal(env.PATH, process.env.PATH, "the configured PATH cannot be swapped from config")
  assert.equal(env.LD_PRELOAD, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.PYTHONPATH, undefined)
  assert.equal(env.MY_API_TOKEN, "allowed-because-named")
  assert.equal(env.OPENAI_API_KEY, undefined, "parent secrets are not inherited")
})

test("a server's own stderr is redacted before it reaches the terminal", async () => {
  const { McpManager } = await import("../../src/mcp/manager.ts")
  const manager = new McpManager({
    servers: [
      {
        name: "leaky",
        transport: "stdio",
        command: "/bin/sh",
        args: ["-c", "echo 'token sk-abcdefghijklmnop' >&2; exit 1"],
        callTimeoutMs: 3_000,
      },
    ],
    log: () => {},
  })
  try {
    await manager.start()
    const status = manager.status()[0]
    assert.equal(status?.ok, false)
    assert.doesNotMatch(status?.reason ?? "", /sk-abcdefghijklmnop/)
    assert.match(status?.reason ?? "", /sk-\*\*\*/)
  } finally {
    await manager.close()
  }
})

test("a server that dies before the handshake rejects instead of crashing the process", async () => {
  // Regression: the write to a dead child fails as EPIPE asynchronously, and an unhandled 'error'
  // on that socket used to take the whole harness down with it.
  const client = new McpClient(config({}, { command: "/bin/sh", args: ["-c", "exit 1"] }))
  try {
    await assert.rejects(client.listTools(), /mcp fake: initialize failed/)
  } finally {
    await client.close()
  }
})
