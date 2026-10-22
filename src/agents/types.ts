import type { TierId } from "../prompts/tiers.ts"

/**
 * A named agent configuration.
 *
 * The same shape is used by two callers, on purpose:
 *   - a plugin can contribute presets, so `task --agent reviewer` means something;
 *   - a subagent run is described by one, so the "who am I" part is never special-cased.
 */
export interface AgentSpec {
  name: string
  /** Appended to the tier persona as a stable system segment. */
  prompt: string
  /** `provider/model`. Omitted means "inherit the parent". */
  model?: string
  tier?: TierId
  /**
   * Allowed tool names. `undefined` means "inherit the parent's tools (minus `task`, subject to
   * depth)". An empty array means "no tools at all", which is a legitimate choice for a pure
   * reasoning helper, so it must not be confused with `undefined`.
   */
  tools?: string[]
}

/** Hard ceilings for one child run. Every field is enforced, none is advisory. */
export interface RunBudget {
  /** Agent-loop step cap. The loop already stops at `max-steps`. */
  maxSteps: number
  /** Nesting allowance. A child at depth >= maxDepth cannot spawn another. */
  maxDepth: number
  /** Optional output-token ceiling summed across the child's steps. */
  maxTokens?: number
}

export type SubagentFinish = "stop" | "max-steps" | "error" | "cancelled"

export interface SubagentResult {
  ok: boolean
  childSessionId: string
  task: string
  /** Final assistant text only - the child's transcript never crosses back. */
  summary: string
  finishReason: SubagentFinish
  steps: number
  tokensIn: number
  tokensOut: number
}
