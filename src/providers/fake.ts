import type { Provider } from "./types.ts"
import type { ProviderEvent, ProviderRequest, ModelCapabilities, Dialect } from "./types.ts"
import { withCapabilities } from "./types.ts"
import { estimateTokens } from "../core/tokens.ts"

/**
 * A deterministic, scripted provider.
 *
 * Every headless test in this repo runs against this thing, so the agent loop, the tool loop,
 * cancellation and persistence are all exercised without a network. Script entries are either a
 * fixed array of events or a function of the request, and a script shorter than the number of
 * calls falls through to the built-in echo behaviour.
 */
export type FakeTurn = ProviderEvent[] | ((request: ProviderRequest) => ProviderEvent[])
export type FakeScript = FakeTurn[]

export interface FakeProviderOptions {
  script?: FakeScript
  /** Artificial delay between events, so cancellation has something to interrupt. */
  delayMs?: number
  capabilities?: Partial<ModelCapabilities>
}

function lastUserText(request: ProviderRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]
    if (message && message.role === "user") return message.content
  }
  return ""
}

/**
 * Report usage that actually tracks the request instead of a fixed number. Tests then have an
 * observable signal for "did the context really contain what I think it did" - which is how the
 * resume tests prove history was reloaded rather than re-faked.
 */
function inputTokens(request: ProviderRequest): number {
  let total = 0
  for (const segment of request.system) total += estimateTokens(segment.text)
  for (const message of request.messages) {
    if (message.role === "user") total += estimateTokens(message.content)
    else if (message.role === "assistant") {
      total += estimateTokens(message.content)
      for (const part of message.parts) {
        if (part.type === "tool-call") total += estimateTokens(JSON.stringify(part.args))
      }
    } else total += estimateTokens(message.parts.map((part) => part.content).join("\n"))
  }
  for (const tool of request.tools ?? []) total += estimateTokens(`${tool.name}${tool.description}`)
  return total
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

export class FakeProvider implements Provider {
  readonly id = "fake"
  readonly dialect: Dialect = "openai"

  #script: FakeScript
  #delayMs: number
  #capabilities: ModelCapabilities
  #calls = 0

  constructor(options: FakeProviderOptions = {}) {
    this.#script = options.script ?? []
    this.#delayMs = options.delayMs ?? 0
    this.#capabilities = withCapabilities(options.capabilities)
  }

  get calls(): number {
    return this.#calls
  }

  capabilities(): ModelCapabilities {
    return this.#capabilities
  }

  listModels(): Promise<string[]> {
    return Promise.resolve(["fake-1"])
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const turn = this.#script[this.#calls]
    this.#calls += 1

    if (turn) {
      const events = typeof turn === "function" ? turn(request) : turn
      for (const event of events) {
        await sleep(this.#delayMs, request.signal)
        if (request.signal.aborted) return
        yield event
      }
      return
    }

    // Default behaviour: echo the last thing the user said, in two chunks, so adapters get
    // something that actually exercises streaming.
    const text = `fake: ${lastUserText(request)}`
    const midpoint = Math.ceil(text.length / 2)
    for (const chunk of [text.slice(0, midpoint), text.slice(midpoint)]) {
      await sleep(this.#delayMs, request.signal)
      if (request.signal.aborted) return
      yield { t: "text", delta: chunk }
    }
    yield { t: "usage", input: inputTokens(request), output: estimateTokens(text) }
    yield { t: "done", finishReason: "stop" }
  }
}
