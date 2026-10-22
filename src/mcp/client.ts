import { VERSION } from "../version.ts"
import { HttpTransport } from "./http.ts"
import { StdioTransport } from "./stdio.ts"
import type {
  McpCallResult,
  McpClientHandle,
  McpContent,
  McpServerConfig,
  McpToolSchema,
  McpTransport,
} from "./types.ts"

const DEFAULT_TIMEOUT_MS = 60_000
/** Servers that ignore `nextCursor` would otherwise spin forever. */
const MAX_TOOL_PAGES = 10

export interface McpClientOptions {
  fetchImpl?: typeof fetch
  clientName?: string
  clientVersion?: string
}

/**
 * One connection to one MCP server.
 *
 * The client owns the lifecycle the JSON-RPC layer does not: the initialize handshake, the
 * paginated tool listing, and the "it died, say so instead of hanging" behaviour.
 */
export class McpClient implements McpClientHandle {
  readonly name: string
  readonly #config: McpServerConfig
  readonly #options: McpClientOptions
  #transport: McpTransport | null = null
  #tools: McpToolSchema[] | null = null
  #started = false
  #deadReason: string | null = null

  constructor(config: McpServerConfig, options: McpClientOptions = {}) {
    this.name = config.name
    this.#config = config
    this.#options = options
  }

  get deadReason(): string | null {
    return this.#deadReason
  }

  get timeoutMs(): number {
    return this.#config.callTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async start(): Promise<void> {
    if (this.#started) return
    const transport = this.#createTransport()
    this.#transport = transport
    transport.onClose((reason) => {
      this.#deadReason = reason
    })

    try {
      await transport.request<unknown>(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: this.#options.clientName ?? "byoa", version: this.#options.clientVersion ?? VERSION },
        },
        AbortSignal.timeout(this.timeoutMs),
      )
      transport.notify("notifications/initialized")
      this.#started = true
    } catch (error: unknown) {
      await transport.close().catch(() => undefined)
      this.#transport = null
      throw new Error(`mcp ${this.name}: initialize failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async listTools(): Promise<McpToolSchema[]> {
    if (this.#tools) return this.#tools
    await this.start()
    const transport = this.#require()
    const found: McpToolSchema[] = []
    let cursor: string | undefined

    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await transport.request<{ tools?: unknown; nextCursor?: unknown }>(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        AbortSignal.timeout(this.timeoutMs),
      )
      for (const tool of normalizeTools(result)) found.push(tool)
      const next = typeof result?.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined
      if (!next || next === cursor) break
      cursor = next
    }

    this.#tools = found
    return found
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    await this.start()
    const transport = this.#require()
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

    const result = await transport.request<{ content?: unknown; isError?: unknown }>(
      "tools/call",
      { name, arguments: args ?? {} },
      combined,
    )
    return {
      content: normalizeContent(result?.content),
      ...(result?.isError === true ? { isError: true } : {}),
    }
  }

  async close(): Promise<void> {
    const transport = this.#transport
    this.#transport = null
    this.#started = false
    await transport?.close().catch(() => undefined)
  }

  #createTransport(): McpTransport {
    if (this.#config.transport === "stdio") {
      if (!this.#config.command) throw new Error(`mcp ${this.name}: stdio transport needs a command`)
      return new StdioTransport(this.name, {
        command: this.#config.command,
        ...(this.#config.args ? { args: this.#config.args } : {}),
        ...(this.#config.cwd ? { cwd: this.#config.cwd } : {}),
        ...(this.#config.env ? { env: this.#config.env } : {}),
      })
    }
    if (!this.#config.url) throw new Error(`mcp ${this.name}: http transport needs a url`)
    return new HttpTransport({
      url: this.#config.url,
      ...(this.#config.headers ? { headers: this.#config.headers } : {}),
      ...(this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {}),
    })
  }

  #require(): McpTransport {
    if (!this.#transport) throw new Error(`mcp ${this.name}: not connected`)
    if (this.#deadReason) throw new Error(`mcp ${this.name}: ${this.#deadReason}`)
    return this.#transport
  }
}

function normalizeTools(result: { tools?: unknown } | null | undefined): McpToolSchema[] {
  const raw = result?.tools
  if (!Array.isArray(raw)) return []
  const tools: McpToolSchema[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue
    const candidate = entry as { name?: unknown; description?: unknown; inputSchema?: unknown }
    if (typeof candidate.name !== "string" || candidate.name.length === 0) continue
    tools.push({
      name: candidate.name,
      description: typeof candidate.description === "string" ? candidate.description : "",
      inputSchema:
        candidate.inputSchema !== null && typeof candidate.inputSchema === "object"
          ? (candidate.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    })
  }
  return tools
}

function normalizeContent(raw: unknown): McpContent[] {
  if (!Array.isArray(raw)) return []
  const content: McpContent[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue
    const candidate = entry as Record<string, unknown>
    content.push({
      type: typeof candidate.type === "string" ? candidate.type : "unknown",
      ...(typeof candidate.text === "string" ? { text: candidate.text } : {}),
      ...(typeof candidate.data === "string" ? { data: candidate.data } : {}),
      ...(typeof candidate.mimeType === "string" ? { mimeType: candidate.mimeType } : {}),
      ...(typeof candidate.uri === "string" ? { uri: candidate.uri } : {}),
    })
  }
  return content
}
