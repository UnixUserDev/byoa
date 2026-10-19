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
  /**
   * Ask the human. The agent supplies this only in `ask` mode, where a frontend is known to be
   * attached and reading events - an adapter that cannot answer must not start the session in ask
   * mode, because the returned promise has nothing to settle it.
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
