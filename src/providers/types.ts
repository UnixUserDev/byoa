/**
 * Provider layer.
 *
 * A provider is a thin binding of a *dialect* (wire protocol) to an endpoint plus credentials.
 * OpenCode does the same thing with its `protocols/` + `providers/` split, and it is the right
 * shape: we implement a handful of dialects carefully and then every OpenAI-compatible server on
 * the planet - Ollama, llama.cpp, LM Studio, vLLM, a random gateway - is configuration, not code.
 */

export const DIALECTS = ["openai", "anthropic"] as const
export type Dialect = (typeof DIALECTS)[number]

export interface ModelCapabilities {
  contextWindow: number
  maxOutput: number
  streaming: boolean
  toolCalls: boolean
  parallelToolCalls: boolean
  reasoning: boolean
  /** Anthropic-style explicit prompt caching breakpoints. */
  cacheControl: boolean
  /** OpenAI `stream_options.include_usage`. */
  supportsStreamUsage: boolean
}

export interface SystemSegment {
  text: string
  /** false marks the volatile tail (memory digest) that must sit after the stable prefix. */
  stable: boolean
  cache?: boolean
}

export interface TextPart {
  type: "text"
  text: string
}

export interface ToolCallPart {
  type: "tool-call"
  id: string
  name: string
  args: unknown
}

export interface ToolResultPart {
  type: "tool-result"
  id: string
  name: string
  ok: boolean
  content: string
  truncated?: boolean
}

export type ProviderMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; parts: Array<TextPart | ToolCallPart> }
  | { role: "tool"; parts: ToolResultPart[] }

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ProviderRequest {
  model: string
  /** Ordered, separately cacheable blocks. Stable ones first, volatile memory last. */
  system: SystemSegment[]
  messages: ProviderMessage[]
  tools?: ToolSchema[]
  toolChoice?: "auto" | "none" | "required"
  maxOutputTokens?: number
  temperature?: number
  signal: AbortSignal
}

export type ProviderEvent =
  | { t: "text"; delta: string }
  | { t: "reasoning"; delta: string }
  | { t: "tool.start"; index: number; id: string; name: string }
  | { t: "tool.args"; index: number; jsonFragment: string }
  | { t: "tool.end"; index: number; id: string; name: string; args: unknown }
  | { t: "usage"; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | { t: "done"; finishReason: "stop" | "tool_calls" | "length" | "error" }
  | { t: "error"; message: string; retryable: boolean; status?: number }

export interface Provider {
  readonly id: string
  readonly dialect: Dialect
  capabilities(model: string): ModelCapabilities
  listModels(): Promise<string[]>
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindow: 128_000,
  maxOutput: 8_192,
  streaming: true,
  toolCalls: true,
  parallelToolCalls: true,
  reasoning: false,
  cacheControl: false,
  supportsStreamUsage: true,
}

export function withCapabilities(overrides?: Partial<ModelCapabilities>): ModelCapabilities {
  return { ...DEFAULT_CAPABILITIES, ...overrides }
}

/**
 * Guess what a model can do from its name, so `--tier` can suggest something sensible and
 * `contextWindow` is not a lie for the budget math. Deliberately conservative: it is better to
 * under-fill the window than to overflow it. Anything explicit in config wins over this.
 */
export function guessCapabilities(model: string, overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  const name = model.toLowerCase()
  const capabilities = { ...DEFAULT_CAPABILITIES }

  const sizeMatch = /(?:^|[^0-9.])(\d+(?:\.\d+)?)\s*b(?:[^0-9a-z]|$)/.exec(name)
  if (sizeMatch?.[1]) {
    const billions = Number(sizeMatch[1])
    if (billions <= 4) {
      capabilities.contextWindow = 32_768
      capabilities.maxOutput = 4_096
    } else {
      capabilities.contextWindow = 131_072
      capabilities.maxOutput = 8_192
    }
  }

  if (name.includes("claude")) {
    capabilities.contextWindow = 200_000
    capabilities.cacheControl = true
    capabilities.reasoning = /opus|sonnet-4|sonnet-5|thinking/.test(name)
  }
  if (/gpt-5|gpt-4\.1|gpt-4o|o3|o4/.test(name)) {
    capabilities.contextWindow = 200_000
    capabilities.reasoning = /(?:^|[-_/])(?:o3|o4|gpt-5)/.test(name)
  }
  if (/gemini/.test(name)) {
    capabilities.contextWindow = 1_000_000
    capabilities.reasoning = /thinking/.test(name)
  }
  if (/r1|qwq|reasoner|reasoning|thinking/.test(name)) capabilities.reasoning = true
  if (/(llama|mistral|qwen|phi|gemma|smollm|tinyllama)/.test(name) && !sizeMatch) {
    capabilities.contextWindow = 32_768
  }

  return { ...capabilities, ...overrides }
}
