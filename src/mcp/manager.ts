import { redact } from "../config/secrets.ts"
import { sanitizeName } from "../tools/names.ts"
import type { Tool } from "../tools/types.ts"
import { mcpTool } from "./adapter.ts"
import { McpClient } from "./client.ts"
import type { McpServerConfig, McpTransportKind } from "./types.ts"

export interface McpServerStatus {
  name: string
  transport: McpTransportKind
  ok: boolean
  tools: number
  reason?: string
}

export interface McpManagerOptions {
  servers: McpServerConfig[]
  log?: (message: string) => void
  fetchImpl?: typeof fetch
}

/**
 * Owns every MCP connection.
 *
 * Fail-soft at start: a server that will not come up is one status line and one warning, never a
 * failed session. Everything else in byoa keeps working, and the model simply does not see those
 * tools - which is true, and better than a tool that errors on every call.
 */
export class McpManager {
  readonly #servers: McpServerConfig[]
  readonly #log: (message: string) => void
  readonly #options: McpManagerOptions
  readonly #clients: Array<{ config: McpServerConfig; client: McpClient }> = []
  readonly #status: McpServerStatus[] = []
  #tools: Tool[] = []
  #started = false

  constructor(options: McpManagerOptions) {
    this.#options = options
    this.#servers = options.servers
    this.#log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`))
  }

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true

    const claimed = new Set<string>()

    for (const server of this.#servers) {
      if (sanitizeName(server.name).length === 0) {
        this.#log(`mcp: ignoring server with an unusable name '${server.name}'`)
        this.#status.push({ name: server.name, transport: server.transport, ok: false, tools: 0, reason: "unusable name" })
        continue
      }

      const client = new McpClient(server, this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {})
      try {
        const schemas = await client.listTools()
        const tools: Tool[] = []
        for (const schema of schemas) {
          const tool = mcpTool(client, schema, {
            serverName: server.name,
            ...(server.mutating === undefined ? {} : { mutating: server.mutating }),
            ...(server.maxResultChars === undefined ? {} : { maxResultChars: server.maxResultChars }),
          })
          if (claimed.has(tool.name)) {
            this.#log(`mcp ${server.name}: skipping duplicate tool name '${tool.name}'`)
            continue
          }
          claimed.add(tool.name)
          tools.push(tool)
        }

        this.#clients.push({ config: server, client })
        this.#tools.push(...tools)
        this.#status.push({ name: server.name, transport: server.transport, ok: true, tools: tools.length })
      } catch (error: unknown) {
        // A server's own stderr ends up in this message. It is untrusted text on its way to a
        // terminal, so it gets the same redaction a tool result does.
        const reason = redact(error instanceof Error ? error.message : String(error))
        await client.close().catch(() => undefined)
        this.#status.push({ name: server.name, transport: server.transport, ok: false, tools: 0, reason })
        this.#log(`mcp ${server.name}: unavailable (${reason}) - continuing without it`)
      }
    }
  }

  tools(): Tool[] {
    return [...this.#tools]
  }

  status(): McpServerStatus[] {
    return [...this.#status]
  }

  get serverCount(): number {
    return this.#clients.length
  }

  async close(): Promise<void> {
    await Promise.all(this.#clients.map((entry) => entry.client.close().catch(() => undefined)))
    this.#clients.length = 0
  }
}
