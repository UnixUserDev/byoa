import type { SandboxPolicy } from "../sandbox/policy.ts"
import type { MemoryStore } from "../memory/types.ts"
import type { ToolSchema } from "../providers/types.ts"

export interface ToolResult {
  ok: boolean
  content: string
  meta?: Record<string, unknown>
}

export interface ApprovalRequest {
  kind: "tool" | "net" | "fs"
  detail: unknown
}

export interface ToolContext {
  cwd: string
  policy: SandboxPolicy
  signal: AbortSignal
  memory: MemoryStore | null
  /** The session this tool call belongs to. */
  sessionId?: string
  /**
   * How many subagent hops below the user this run sits. 0 is the top-level agent. A delegating
   * tool reads it to refuse past its depth budget; everything else can ignore it.
   */
  depth?: number
  /**
   * Ask the human. Settles only in `ask` mode, where a frontend is reading events; in `auto` mode
   * the returned promise rejects immediately rather than waiting for an answer that cannot come.
   */
  requestApproval(request: ApprovalRequest): Promise<boolean>
}

export interface Tool {
  readonly name: string
  readonly description: string
  /** Mutating tools are what the approval policy and the sandbox exist for. */
  readonly mutating: boolean
  /** JSON Schema for the arguments object. */
  readonly parameters: Record<string, unknown>
  validate?(args: unknown): string | null
  run(args: unknown, context: ToolContext): Promise<ToolResult>
}

export function schemaOf(tool: Tool): ToolSchema {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}
