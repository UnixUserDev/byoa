import type { TierId } from "../prompts/tiers.ts"
import type { SandboxPolicy, SandboxPolicyPatch } from "../sandbox/policy.ts"
import type { RecallHit } from "../memory/types.ts"

/**
 * The frontend contract.
 *
 * The core emits AgentEvents in a documented order; adapters render them and push AgentCommands
 * back. Nothing else crosses the boundary - no adapter ever reaches into agent internals. This is
 * what makes CLI, TUI, Web and Electron cheap: they are all just terminals on this wire.
 *
 * Emission order inside a turn:
 *   turn.start -> (text | reasoning | memory.* | tool.call | tool.result | approval.request)*
 *   -> usage -> turn.end
 */

export type AgentEvent =
  | { t: "session.info"; id: string; title: string; provider: string; model: string; tier: TierId; cwd: string }
  | { t: "turn.start"; turn: number }
  | { t: "text"; delta: string }
  | { t: "reasoning"; delta: string }
  | { t: "memory.recall"; query: string; hits: RecallHit[]; tokens: number }
  | { t: "memory.write"; path: string; title: string; tag: string; rejected?: string }
  | { t: "tool.call"; id: string; name: string; args: unknown; mutating: boolean }
  | { t: "tool.result"; id: string; name: string; ok: boolean; content: string; truncated?: boolean; meta?: Record<string, unknown> }
  | { t: "sandbox.info"; applied: boolean; degraded: boolean; reason?: string; policy: SandboxPolicy }
  | { t: "approval.request"; id: string; kind: "tool" | "net" | "fs"; detail: unknown }
  | { t: "usage"; turnInput: number; turnOutput: number; sessionInput: number; sessionOutput: number }
  | { t: "turn.end"; turn: number; finishReason: TurnFinishReason }
  | { t: "error"; message: string; fatal: boolean }

export type TurnFinishReason = "stop" | "cancelled" | "max-steps" | "error"

export type AgentCommand =
  | { t: "submit"; text: string }
  | { t: "cancel" }
  | { t: "approve"; id: string; allow: boolean; remember?: boolean }
  | { t: "set.model"; provider: string; model: string }
  | { t: "set.tier"; tier: TierId }
  | { t: "set.policy"; patch: SandboxPolicyPatch }
  | { t: "set.memory"; backend: "obsidian" | "sqlite"; vault?: string }
  | { t: "resume"; sessionId: string }

/**
 * The handle an adapter is given. Deliberately tiny: read events, send commands, ask about the
 * session, shut down.
 */
export interface AgentHandle {
  events(): AsyncIterable<AgentEvent>
  send(command: AgentCommand): void
  session(): Promise<{ id: string; title: string; provider: string; model: string; tier: TierId }>
  idle(): Promise<void>
  dispose(): Promise<void>
}
