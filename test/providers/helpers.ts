import type { ProviderEvent, ProviderRequest } from "../../src/providers/types.ts"

/** A Response whose body is a scripted SSE stream, so parsers are testable with no network. */
export function sseResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } })
}

export function data(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`
}

export function event(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

export function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "test-model",
    system: [{ text: "you are a test", stable: true }],
    messages: [{ role: "user", content: "hi" }],
    signal: new AbortController().signal,
    ...overrides,
  }
}

export async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = []
  for await (const item of iterable) events.push(item)
  return events
}
