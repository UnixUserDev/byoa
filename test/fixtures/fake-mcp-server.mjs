#!/usr/bin/env node
/**
 * A fake MCP server for the test suite.
 *
 * Speaks newline-delimited JSON-RPC, like the spec says. Env switches let one fixture cover the
 * awkward cases without spawning a menagerie of scripts:
 *   FAKE_MCP_FRAMING=lsp     reply with Content-Length headers instead of bare lines
 *   FAKE_MCP_HANG=call       never answer tools/call (timeout path)
 *   FAKE_MCP_DIE=call        exit mid-call (dead-server path)
 *   FAKE_MCP_PAGINATE=1      return the tool list over two pages with a cursor
 *   FAKE_MCP_TOOLS=a,b       tool names to expose
 *   FAKE_MCP_STDERR=1        write a diagnostic line to stderr on start
 */
import { createInterface } from "node:readline"

const framing = process.env.FAKE_MCP_FRAMING ?? "line"
const hang = process.env.FAKE_MCP_HANG ?? ""
const die = process.env.FAKE_MCP_DIE ?? ""
const paginate = process.env.FAKE_MCP_PAGINATE === "1"
const toolNames = (process.env.FAKE_MCP_TOOLS ?? "echo").split(",").filter(Boolean)

if (process.env.FAKE_MCP_STDERR === "1") process.stderr.write("fake mcp server ready\n")

let cursorSent = false

function send(message) {
  const payload = JSON.stringify(message)
  if (framing === "lsp") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`)
    return
  }
  process.stdout.write(`${payload}\n`)
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result })
}

const rl = createInterface({ input: process.stdin })

rl.on("line", (line) => {
  const text = line.trim()
  if (text.length === 0) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }

  if (message.id === undefined) return // notification

  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-mcp", version: "0.0.1" },
    })
    return
  }

  if (message.method === "tools/list") {
    if (paginate && !cursorSent) {
      cursorSent = true
      reply(message.id, {
        tools: [describe(toolNames[0] ?? "echo")],
        nextCursor: "page-2",
      })
      return
    }
    const tools = paginate ? toolNames.slice(1).map(describe) : toolNames.map(describe)
    reply(message.id, { tools })
    return
  }

  if (message.method === "tools/call") {
    if (die === "call") process.exit(3)
    if (hang === "call") return
    const args = message.params?.arguments ?? {}
    if (args.fail === true) {
      reply(message.id, { content: [{ type: "text", text: "it went wrong" }], isError: true })
      return
    }
    if (args.image === true) {
      reply(message.id, {
        content: [
          { type: "text", text: "here is a picture" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      })
      return
    }
    if (typeof args.size === "number") {
      reply(message.id, { content: [{ type: "text", text: "x".repeat(args.size) }] })
      return
    }
    reply(message.id, {
      content: [{ type: "text", text: JSON.stringify({ tool: message.params?.name, args }) }],
    })
    return
  }

  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no such method: ${message.method}` } })
})

function describe(name) {
  return {
    name,
    description: `fake ${name} tool`,
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  }
}
