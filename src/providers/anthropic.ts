import type {
  Dialect,
  ModelCapabilities,
  Provider,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  SystemSegment,
  ToolSchema,
} from "./types.ts"
import { guessCapabilities } from "./types.ts"
import { parseSse } from "./sse.ts"
import { ToolCallAccumulator, parseToolArgs } from "./accum.ts"
import { redact } from "../config/secrets.ts"

/**
 * The Anthropic Messages dialect.
 *
 * It differs from OpenAI in three ways that matter: tool results are `user` content blocks rather
 * than their own role, the system prompt is a structured block list, and prompt caching is
 * explicit - you place `cache_control` breakpoints yourself (max 4) instead of getting implicit
 * prefix caching. We spend exactly one breakpoint, on the last stable system segment, which caches
 * the whole stable prefix including the tool definitions.
 */
export interface AnthropicOptions {
  id: string
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  capabilities?: Partial<ModelCapabilities>
  /** Defaults to a dated stable version; override if you are pinned to another. */
  apiVersion?: string
}

interface AnthropicPayload {
  type?: string
  index?: number
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; stop_reason?: string }
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
  error?: { message?: string; type?: string }
}

function toSystemBlocks(system: SystemSegment[]): Array<Record<string, unknown>> {
  const kept = system
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.text.trim().length > 0)

  const stableIndexes = kept.filter(({ segment }) => segment.stable).map(({ index }) => index)
  const lastStable = stableIndexes.length > 0 ? Math.max(...stableIndexes) : -1

  return kept.map(({ segment, index }) => ({
    type: "text",
    text: segment.text,
    // One breakpoint, on the tail of the stable prefix: everything before it is cached.
    ...(index === lastStable ? { cache_control: { type: "ephemeral" } } : {}),
  }))
}

function toAnthropicMessages(messages: ProviderMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []

  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content })
      continue
    }
    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = []
      if (message.content.length > 0) content.push({ type: "text", text: message.content })
      for (const part of message.parts) {
        if (part.type === "tool-call") {
          content.push({ type: "tool_use", id: part.id, name: part.name, input: part.args ?? {} })
        }
      }
      out.push({ role: "assistant", content: content.length > 0 ? content : [{ type: "text", text: "" }] })
      continue
    }
    // Tool results ride inside a user turn.
    out.push({
      role: "user",
      content: message.parts.map((part) => ({
        type: "tool_result",
        tool_use_id: part.id,
        content: part.content,
        ...(part.ok ? {} : { is_error: true }),
      })),
    })
  }
  return out
}

function toAnthropicTool(tool: ToolSchema): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters }
}

async function safeText(response: Response): Promise<string> {
  try {
    // An error body can echo the request, API key included, and it lands in the transcript.
    return redact((await response.text()).slice(0, 500))
  } catch {
    return "<unreadable body>"
  }
}

export class AnthropicProvider implements Provider {
  readonly id: string
  readonly dialect: Dialect = "anthropic"

  readonly #baseUrl: string
  readonly #apiKey: string | undefined
  readonly #extraHeaders: Record<string, string>
  readonly #fetch: typeof fetch
  readonly #capabilityOverrides: Partial<ModelCapabilities>
  readonly #apiVersion: string

  constructor(options: AnthropicOptions) {
    this.id = options.id
    this.#baseUrl = options.baseUrl.replace(/\/$/, "")
    this.#apiKey = options.apiKey
    this.#extraHeaders = options.headers ?? {}
    this.#fetch = options.fetchImpl ?? fetch
    this.#capabilityOverrides = options.capabilities ?? {}
    this.#apiVersion = options.apiVersion ?? "2023-06-01"
  }

  capabilities(model: string): ModelCapabilities {
    return guessCapabilities(model, { cacheControl: true, ...this.#capabilityOverrides })
  }

  listModels(): Promise<string[]> {
    // The Anthropic API does not expose a model listing endpoint.
    return Promise.resolve([])
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": this.#apiVersion,
      ...this.#extraHeaders,
    }
    if (this.#apiKey && this.#apiKey.length > 0) headers["x-api-key"] = this.#apiKey
    return headers
  }

  #body(request: ProviderRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? 8_192,
      system: toSystemBlocks(request.system),
      messages: toAnthropicMessages(request.messages),
      stream: true,
    }
    if (request.tools && request.tools.length > 0) body.tools = request.tools.map(toAnthropicTool)
    if (request.temperature !== undefined) body.temperature = request.temperature
    return body
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(this.#body(request)),
        signal: request.signal,
      })
    } catch (error: unknown) {
      yield {
        t: "error",
        message: `request failed: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      }
      return
    }

    if (!response.ok) {
      const detail = await safeText(response)
      yield {
        t: "error",
        message: `HTTP ${response.status} from ${this.id}: ${detail}`,
        retryable: response.status >= 500 || response.status === 429,
        status: response.status,
      }
      return
    }
    if (!response.body) {
      yield { t: "error", message: `${this.id} returned no response body`, retryable: true }
      return
    }

    const accumulator = new ToolCallAccumulator()
    let finishReason: "stop" | "tool_calls" | "length" | "error" = "stop"

    for await (const event of parseSse(response.body as unknown as AsyncIterable<Uint8Array>)) {
      let payload: AnthropicPayload
      try {
        payload = JSON.parse(event.data) as AnthropicPayload
      } catch {
        continue
      }

      const type = payload.type ?? event.event ?? ""

      switch (type) {
        case "message_start": {
          const usage = payload.message?.usage
          if (usage) {
            // Input tokens are only reliable here; `output_tokens` at message_start is a placeholder.
            // The final count arrives on message_delta, and the agent SUMS usage across events - so
            // reporting both here and there double-counted input and inflated output by a constant.
            const usageEvent: ProviderEvent = {
              t: "usage",
              input: usage.input_tokens ?? 0,
              output: 0,
            }
            yield usage.cache_read_input_tokens === undefined
              ? usageEvent
              : { ...usageEvent, cacheRead: usage.cache_read_input_tokens }
          }
          break
        }
        case "content_block_start": {
          const block = payload.content_block
          if (block?.type === "tool_use") {
            const index = payload.index ?? 0
            const id = block.id ?? ""
            const name = block.name ?? ""
            accumulator.start(index, id, name)
            yield { t: "tool.start", index, id: id.length > 0 ? id : `call_${index}`, name }
          }
          break
        }
        case "content_block_delta": {
          const delta = payload.delta ?? {}
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            yield { t: "text", delta: delta.text }
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const index = payload.index ?? 0
            accumulator.args(index, delta.partial_json)
            yield { t: "tool.args", index, jsonFragment: delta.partial_json }
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            yield { t: "reasoning", delta: delta.thinking }
          }
          break
        }
        case "message_delta": {
          const reason = payload.delta?.stop_reason
          if (typeof reason === "string") {
            finishReason = reason === "tool_use" ? "tool_calls" : reason === "max_tokens" ? "length" : "stop"
          }
          if (payload.usage) {
            // Output is only reliable here; input was already counted at message_start. A proxy that
            // repeats input_tokens in this frame would otherwise double the input count.
            yield { t: "usage", input: 0, output: payload.usage.output_tokens ?? 0 }
          }
          break
        }
        case "error": {
          yield { t: "error", message: redact(payload.error?.message ?? "anthropic stream error"), retryable: false }
          break
        }
        default:
          break
      }
    }

    for (const draft of accumulator.drafts()) {
      if (draft.name.length === 0) continue
      yield {
        t: "tool.end",
        index: draft.index,
        id: draft.id.length > 0 ? draft.id : `call_${draft.index}`,
        name: draft.name,
        args: parseToolArgs(draft.argsText),
      }
    }

    yield { t: "done", finishReason }
  }
}
