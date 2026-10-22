/** Transport kinds this client actually implements. Nothing else is silently ignored. */
export const MCP_TRANSPORTS = ["stdio", "http"] as const
export type McpTransportKind = (typeof MCP_TRANSPORTS)[number]

export interface McpServerConfig {
  /** Unique. Becomes the middle segment of every tool name (`mcp__<name>__<tool>`). */
  name: string
  transport: McpTransportKind
  /** stdio only: the executable to spawn. Runs on the host, not inside the sandbox. */
  command?: string
  args?: string[]
  /**
   * stdio only: extra environment for the child. The parent environment is NOT inherited wholesale,
   * and `PATH` plus the loader/interpreter hooks (`LD_*`, `NODE_OPTIONS`, `JAVA_TOOL_OPTIONS`, ...)
   * are refused even when named here - use an absolute `command` instead of rewriting `PATH`.
   */
  env?: Record<string, string>
  cwd?: string
  /** http only. */
  url?: string
  headers?: Record<string, string>
  /** Per-result character cap before the tier budget gets a second go at it. */
  maxResultChars?: number
  /** Per-request wall clock. A hung server must not hang a turn. */
  callTimeoutMs?: number
  /**
   * Default `mutating` for this server's tools. Defaults to true: an MCP tool can do anything the
   * server can, so it belongs behind the approval gate unless the user says otherwise.
   */
  mutating?: boolean
}

/**
 * The JSON-RPC boundary. Transports know about pipes and sockets; nothing above them does.
 */
export interface McpTransport {
  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>
  notify(method: string, params?: unknown): void
  onNotification(handler: (method: string, params: unknown) => void): void
  onClose(handler: (reason: string) => void): void
  close(): Promise<void>
}

export interface McpToolSchema {
  name: string
  description: string
  /** JSON Schema. Maps 1:1 onto `Tool.parameters`. */
  inputSchema: Record<string, unknown>
}

export interface McpContent {
  type: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
}

export interface McpCallResult {
  content: McpContent[]
  isError?: boolean
}

/** The client half of MCP that the tool adapter is allowed to see. */
export interface McpClientHandle {
  readonly name: string
  listTools(): Promise<McpToolSchema[]>
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>
  close(): Promise<void>
}
