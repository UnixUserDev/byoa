import { parseSse } from "../providers/sse.ts"
import type { McpTransport } from "./types.ts"

const PROTOCOL_VERSION = "2025-06-18"
/**
 * A reply this big is already far past anything the context window can hold (the per-result cap is
 * 64 KiB by default). The point of reading with a ceiling rather than slicing afterwards is that a
 * hostile server cannot make us buffer a gigabyte before we get to slice it.
 */
const MAX_REPLY_BYTES = 4 * 1024 * 1024
const MAX_SESSION_ID_LENGTH = 512

export interface HttpTransportOptions {
  url: string
  headers?: Record<string, string>
  /** Injectable for tests, like the provider layer does. */
  fetchImpl?: typeof fetch
  /** Reply ceiling in bytes. Exposed so a test does not have to allocate 4 MiB. */
  maxReplyBytes?: number
}

interface JsonRpcReply {
  id?: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
  method?: string
  params?: unknown
}

/**
 * Streamable HTTP transport.
 *
 * One POST per message, JSON or SSE in the reply. What this deliberately does not do: hold a GET
 * SSE stream open for server-initiated notifications. byoa calls tools and reads results; a server
 * that wants to push a notification at us gets silence, and that is documented rather than faked.
 */
export class HttpTransport implements McpTransport {
  readonly #url: string
  readonly #headers: Record<string, string>
  readonly #fetch: typeof fetch
  readonly #onClose: Array<(reason: string) => void> = []
  readonly #onNotification: Array<(method: string, params: unknown) => void> = []
  readonly #maxReplyBytes: number
  /** Aborted by `close()` so a pending fetch does not outlive the transport. */
  readonly #lifetime = new AbortController()
  #sessionId: string | null = null
  #nextId = 1
  #closed = false

  constructor(options: HttpTransportOptions) {
    this.#url = options.url
    this.#headers = options.headers ?? {}
    this.#fetch = options.fetchImpl ?? fetch
    this.#maxReplyBytes = options.maxReplyBytes ?? MAX_REPLY_BYTES
  }

  get sessionId(): string | null {
    return this.#sessionId
  }

  async request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.#closed) throw new Error("mcp http: transport is closed")
    const id = this.#nextId
    this.#nextId += 1
    const reply = await this.#post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, signal, id)
    if (!reply) throw new Error(`mcp http: no reply for ${method}`)
    if (reply.error) throw new Error(`${reply.error.message} (code ${reply.error.code})`)
    return (reply.result ?? null) as T
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return
    // Fire and forget: a notification has no reply, and a failed one must not take down a turn.
    void this.#post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }).catch(() => undefined)
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.#onNotification.push(handler)
  }

  onClose(handler: (reason: string) => void): void {
    this.#onClose.push(handler)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#lifetime.abort()
    if (!this.#sessionId) return
    // Best effort: the spec allows DELETE to end a session, servers that do not support it answer
    // 405 and that is not a problem worth surfacing.
    try {
      await this.#fetch(this.#url, {
        method: "DELETE",
        headers: this.#requestHeaders(),
      })
    } catch {
      // ignore
    }
  }

  #requestHeaders(): Record<string, string> {
    // Protocol headers come last: a config header called `content-type` would otherwise break
    // framing, and a stale `mcp-session-id` would silently detach the session.
    return {
      ...this.#headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...(this.#sessionId ? { "mcp-session-id": this.#sessionId } : {}),
    }
  }

  async #post(body: unknown, signal?: AbortSignal, expectId?: number): Promise<JsonRpcReply | null> {
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: this.#requestHeaders(),
      body: JSON.stringify(body),
      // Raced with the transport's lifetime: a close() during a call must not leave the fetch
      // running for another 60 seconds.
      signal: signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal,
    })

    const sessionId = response.headers.get("mcp-session-id")
    // A server controls this header. Bound it and reject control characters before echoing it back.
    if (sessionId && sessionId.length <= MAX_SESSION_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(sessionId)) {
      this.#sessionId = sessionId
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`mcp http ${response.status}${text.length > 0 ? `: ${text.slice(0, 200)}` : ""}`)
    }

    const contentType = response.headers.get("content-type") ?? ""
    if (contentType.includes("text/event-stream") && response.body) {
      const stream = cappedStream(response.body, this.#maxReplyBytes)
      for await (const event of parseSse(stream)) {
        const parsed = safeParse(event.data)
        if (!parsed) continue
        const reply = Array.isArray(parsed) ? parsed.find((entry) => entry.id === expectId) : parsed
        if (!reply) continue
        if (reply.method !== undefined && reply.id === undefined) {
          for (const handler of this.#onNotification) handler(reply.method, reply.params)
          continue
        }
        if (expectId === undefined || reply.id === expectId) return reply
      }
      return null
    }

    const text = await readCapped(response, this.#maxReplyBytes)
    if (text.trim().length === 0) return null
    const parsed = safeParse(text)
    if (!parsed) throw new Error("mcp http: reply was not JSON")
    if (Array.isArray(parsed)) {
      return parsed.find((entry) => entry.id === expectId) ?? null
    }
    return parsed
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`mcp http: reply exceeded ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

async function* cappedStream(body: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        throw new Error(`mcp http: reply exceeded ${maxBytes} bytes`)
      }
      yield value
    }
  } finally {
    // The normal exit is an early `return` from the SSE loop once the matching reply has arrived.
    // Without cancelling, the body stays locked and the connection stays open until the server
    // decides to finish a stream nobody is reading.
    await reader.cancel().catch(() => undefined)
    try {
      reader.releaseLock()
    } catch {
      // Already released by cancel(); releasing twice is not an error worth propagating.
    }
  }
}

function safeParse(text: string): JsonRpcReply | JsonRpcReply[] | null {
  try {
    return JSON.parse(text) as JsonRpcReply | JsonRpcReply[] | null
  } catch {
    return null
  }
}
