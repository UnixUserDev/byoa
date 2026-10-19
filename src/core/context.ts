import type { ProviderMessage, SystemSegment, ToolSchema } from "../providers/types.ts"
import type { PromptTier } from "../prompts/tiers.ts"

/**
 * Context assembly.
 *
 * The ordering rule here is the whole reason the provider prompt cache keeps hitting: stable
 * segments first (persona, safety, tool docs - none of which change during a session), and the
 * volatile memory digest appended LAST as its own segment. Anything that changes per-request
 * placed before the stable prefix would invalidate the cached prefix on every single turn.
 */
export function buildSystemSegments(tier: PromptTier, memoryBlock?: string): SystemSegment[] {
  const segments: SystemSegment[] = [
    { text: tier.persona, stable: true, cache: true },
    { text: tier.safety, stable: true, cache: true },
  ]
  if (memoryBlock && memoryBlock.trim().length > 0) {
    segments.push({ text: memoryBlock, stable: false })
  }
  return segments
}

export interface BuildRequestInput {
  model: string
  system: SystemSegment[]
  history: ProviderMessage[]
  tools: ToolSchema[]
  signal: AbortSignal
  maxOutputTokens?: number
  temperature?: number
}

export function buildRequest(input: BuildRequestInput): {
  model: string
  system: SystemSegment[]
  messages: ProviderMessage[]
  tools?: ToolSchema[]
  maxOutputTokens?: number
  temperature?: number
  signal: AbortSignal
} {
  return {
    model: input.model,
    system: input.system,
    messages: input.history,
    ...(input.tools.length > 0 ? { tools: input.tools } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    signal: input.signal,
  }
}

/** Structural equality on the stable prefix, used to detect accidental cache invalidation. */
export function stablePrefixKey(system: SystemSegment[]): string {
  return system
    .filter((segment) => segment.stable)
    .map((segment) => segment.text)
    .join("\u0000")
}
