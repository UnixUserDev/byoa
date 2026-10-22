import { sanitizeName } from "../tools/names.ts"
import type { Tool, ToolResult } from "../tools/types.ts"
import type { McpCallResult, McpClientHandle, McpContent, McpServerConfig, McpToolSchema } from "./types.ts"

const DEFAULT_MAX_RESULT_CHARS = 64 * 1024
/** Still large enough for a big file, small enough that a typo in config cannot eat the heap. */
const MAX_RESULT_CHARS_CEILING = 1024 * 1024

/** `mcp__<server>__<tool>` - server in the middle so all of one server's tools group together. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeName(serverName)}__${sanitizeName(toolName)}`
}

export interface McpToolOptions {
  serverName: string
  /** Default `mutating` for this server's tools. Defaults to true. */
  mutating?: boolean
  maxResultChars?: number
}

/**
 * Turn an MCP tool description into a byoa Tool.
 *
 * The mapping is deliberately thin: MCP already gives us a name, a description and a JSON Schema,
 * which is exactly what `Tool` wants. The only real work is turning the content array into the one
 * string the model gets to see, and capping it so a server that returns a whole filesystem cannot
 * eat the window.
 */
export function mcpTool(
  client: McpClientHandle,
  schema: McpToolSchema,
  options: McpToolOptions,
): Tool {
  const fullName = mcpToolName(options.serverName, schema.name)
  const maxChars = clampChars(options.maxResultChars)

  return {
    name: fullName,
    description: `[mcp:${options.serverName}] ${schema.description}`.trim(),
    mutating: options.mutating ?? true,
    parameters: schema.inputSchema,
    async run(args: unknown, context): Promise<ToolResult> {
      let result: McpCallResult
      try {
        result = await client.callTool(schema.name, args, context.signal)
      } catch (error: unknown) {
        return { ok: false, content: `mcp ${options.serverName}/${schema.name}: ${error instanceof Error ? error.message : String(error)}` }
      }

      const { text, truncated } = renderContent(result.content, maxChars)
      const ok = result.isError !== true
      return {
        ok,
        content: ok && text.length === 0 ? "(no content)" : text,
        meta: {
          server: options.serverName,
          tool: schema.name,
          ...(truncated ? { truncated: true } : {}),
        },
      }
    },
  }
}

function clampChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_RESULT_CHARS
  return Math.min(Math.floor(value), MAX_RESULT_CHARS_CEILING)
}

/** Text is joined; images and resources become a one-line description, since the model is text-only. */
export function renderContent(content: McpContent[], maxChars: number): { text: string; truncated: boolean } {
  const pieces: string[] = []
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      pieces.push(item.text)
      continue
    }
    if (item.type === "image") {
      const bytes = typeof item.data === "string" ? Math.floor((item.data.length * 3) / 4) : 0
      pieces.push(`[image ${item.mimeType ?? "unknown"}${bytes > 0 ? `, ~${bytes} bytes` : ""} - not shown to a text model]`)
      continue
    }
    if (item.type === "resource") {
      pieces.push(`[resource ${item.uri ?? "unknown"}]${typeof item.text === "string" ? ` ${item.text}` : ""}`)
      continue
    }
    pieces.push(`[${item.type} content${item.mimeType ? ` ${item.mimeType}` : ""}]`)
  }

  const joined = pieces.join("\n")
  if (joined.length <= maxChars) return { text: joined, truncated: false }
  return { text: `${joined.slice(0, maxChars)}\n[... truncated at ${maxChars} characters]`, truncated: true }
}

/** Compose config-declared servers with plugin-declared ones. Config wins, field by field. */
export function composeMcpServers(
  fromConfig: McpServerConfig[],
  fromPlugins: McpServerConfig[],
): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>()
  for (const server of fromPlugins) merged.set(server.name, server)
  for (const server of fromConfig) {
    const existing = merged.get(server.name)
    if (!existing) {
      merged.set(server.name, server)
      continue
    }
    const combined: McpServerConfig = { ...existing, ...server }
    // A merge that changes transport must not carry the other transport's fields along: a "http"
    // server still holding the plugin's `command` is a config that lies about itself.
    if (existing.transport !== server.transport) {
      if (server.transport === "http") {
        delete combined.command
        delete combined.args
        delete combined.cwd
        delete combined.env
      } else {
        delete combined.url
        delete combined.headers
      }
    }
    merged.set(server.name, combined)
  }
  return [...merged.values()]
}
