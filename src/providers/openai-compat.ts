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
 * The OpenAI chat-completions dialect.
 *
 * This one file is why "any endpoint you want" is a config change instead of a project: OpenAI,
 * Ollama, llama.cpp, LM Studio, vLLM, OpenRouter, Groq, DeepSeek, Together and every gateway that
 * copies the shape all speak this.
 */
export interface OpenAiCompatibleOptions {
  id: string
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  /** Injected in tests so the parser can be exercised against fixtures with no network. */
  fetchImpl?: typeof fetch
  capabilities?: Partial<ModelCapabilities>
}

interface OpenAiToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAiChoice {
  delta?: {
    content?: string
    reasoning_content?: string
    reasoning?: string
    tool_calls?: OpenAiToolCallDelta[]
  }
  finish_reason?: string
}

interface OpenAiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

interface OpenAiChunk {
  choices?: OpenAiChoice[]
  usage?: OpenAiUsage
  error?: { message?: string }
}

function toOpenAiMessages(system: SystemSegment[], messages: ProviderMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const systemText = system
    .map((segment) => segment.text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n")
  if (systemText.length > 0) out.push({ role: "system", content: systemText })

  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content })
      continue
    }
    if (message.role === "assistant") {
      const toolCalls = message.parts.filter((part) => part.type === "tool-call")
      const payload: Record<string, unknown> = {
        role: "assistant",
        content: message.content.length > 0 ? message.content : null,
      }
      if (toolCalls.length > 0) {
        payload.tool_calls = toolCalls.map((part) => ({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.args ?? {}) },
        }))
      }
      out.push(payload)
      continue
    }
    // OpenAI wants one message per tool result, addressed by tool_call_id.
    for (const part of message.parts) {
      out.push({ role: "tool", tool_call_id: part.id, content: part.content })
    }
  }
  return out
}

function toOpenAiTool(tool: ToolSchema): Record<string, unknown> {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
}

async function safeText(response: Response): Promise<string> {
  try {
    // Gateways sometimes echo the request back in an error body, API key included, and this text
    // goes straight to the transcript and the session database.
    return redact((await response.text()).slice(0, 500))
  } catch {
    return "<unreadable body>"
  }
}

export class OpenAiCompatibleProvider implements Provider {
  readonly id: string
  readonly dialect: Dialect = "openai"

  readonly #baseUrl: string
  readonly #apiKey: string | undefined
  readonly #extraHeaders: Record<string, string>
  readonly #fetch: typeof fetch
  readonly #capabilityOverrides: Partial<ModelCapabilities>

  constructor(options: OpenAiCompatibleOptions) {
    this.id = options.id
    this.#baseUrl = options.baseUrl.replace(/\/$/, "")
    this.#apiKey = options.apiKey
    this.#extraHeaders = options.headers ?? {}
    this.#fetch = options.fetchImpl ?? fetch
    this.#capabilityOverrides = options.capabilities ?? {}
  }

  capabilities(model: string): ModelCapabilities {
    return guessCapabilities(model, this.#capabilityOverrides)
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await this.#fetch(`${this.#baseUrl}/models`, { headers: this.#headers() })
      if (!response.ok) return []
      const payload = (await response.json()) as { data?: Array<{ id?: unknown }> }
      return (payload.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string")
    } catch {
      return []
    }
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json", ...this.#extraHeaders }
    if (this.#apiKey && this.#apiKey.length > 0) headers.authorization = `Bearer ${this.#apiKey}`
    return headers
  }

  #body(request: ProviderRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAiMessages(request.system, request.messages),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(toOpenAiTool)
      body.tool_choice = request.toolChoice ?? "auto"
    }
    if (request.maxOutputTokens !== undefined) {
      // o-series and gpt-5 reject `max_tokens` and require `max_completion_tokens`; the capability
      // layer already flags those as reasoning models.
      const field = this.capabilities(request.model).reasoning ? "max_completion_tokens" : "max_tokens"
      body[field] = request.maxOutputTokens
    }
    if (request.temperature !== undefined) body.temperature = request.temperature
    return body
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(this.#body(request)),
        signal: request.signal,
      })
    } catch (error: unknown) {
      yield {
        t: "error",
        message: `request failed: ${redact(error instanceof Error ? error.message : String(error))}`,
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
    const announced = new Map<number, { id: string; name: string }>()
    let finishReason: "stop" | "tool_calls" | "length" | "error" = "stop"

    for await (const event of parseSse(response.body as unknown as AsyncIterable<Uint8Array>)) {
      if (event.data === "[DONE]") break

      let chunk: OpenAiChunk
      try {
        chunk = JSON.parse(event.data) as OpenAiChunk
      } catch {
        continue
      }

      if (chunk.error?.message) {
        yield { t: "error", message: redact(chunk.error.message), retryable: false }
        continue
      }

      const choice = chunk.choices?.[0]
      if (choice) {
        const delta = choice.delta ?? {}
        const reasoning =
          typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta.reasoning === "string"
              ? delta.reasoning
              : undefined
        if (reasoning && reasoning.length > 0) yield { t: "reasoning", delta: reasoning }
        if (typeof delta.content === "string" && delta.content.length > 0) yield { t: "text", delta: delta.content }

        for (const call of delta.tool_calls ?? []) {
          const index = typeof call.index === "number" ? call.index : 0
          const id = typeof call.id === "string" ? call.id : ""
          const name = typeof call.function?.name === "string" ? call.function.name : ""
          const fragment = call.function?.arguments
          if (id.length === 0 && name.length === 0 && typeof fragment !== "string") continue
          accumulator.start(index, id, name)

          // Gateways differ: some send `id` and `function.name` in one delta, others split them
          // across frames. Emitting `tool.start` only once meant a split delivery produced a tool
          // call with an empty name, and the agent spent its whole step budget on `unknown tool ''`.
          // Re-announcing when the missing half arrives is safe: the agent merges idempotently.
          const prior = announced.get(index)
          const gainedName = name.length > 0 && (prior?.name.length ?? 0) === 0
          const gainedId = id.length > 0 && (prior?.id.length ?? 0) === 0
          if ((id.length > 0 || name.length > 0) && (prior === undefined || gainedName || gainedId)) {
            announced.set(index, {
              id: id.length > 0 ? id : (prior?.id ?? ""),
              name: name.length > 0 ? name : (prior?.name ?? ""),
            })
            yield { t: "tool.start", index, id, name }
          }

          if (typeof fragment === "string" && fragment.length > 0) {
            accumulator.args(index, fragment)
            yield { t: "tool.args", index, jsonFragment: fragment }
          }
        }

        if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
          finishReason =
            choice.finish_reason === "tool_calls"
              ? "tool_calls"
              : choice.finish_reason === "length"
                ? "length"
                : "stop"
        }
      }

      const usage = chunk.usage
      if (usage) {
        const event0: ProviderEvent = {
          t: "usage",
          input: usage.prompt_tokens ?? 0,
          output: usage.completion_tokens ?? 0,
        }
        const cached = usage.prompt_tokens_details?.cached_tokens
        yield cached === undefined ? event0 : { ...event0, cacheRead: cached }
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
