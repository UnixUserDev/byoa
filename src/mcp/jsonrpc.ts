/**
 * JSON-RPC 2.0 correlation.
 *
 * Kept separate from the transports so stdio and HTTP share one implementation of the boring part:
 * request ids, pending promises, error mapping, notifications, and the tidy-up that has to happen
 * when the connection dies underneath a call that is still waiting.
 */

export interface JsonRpcErrorBody {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcMessage =
  | { jsonrpc: "2.0"; id: number | string; result: unknown }
  | { jsonrpc: "2.0"; id: number | string; error: JsonRpcErrorBody }
  | { jsonrpc: "2.0"; method: string; params?: unknown; id?: number | string }

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  detach(): void
}

export class JsonRpcTimeoutError extends Error {}

export class JsonRpc {
  readonly #send: (message: JsonRpcMessage) => void
  readonly #pending = new Map<number, Pending>()
  readonly #notifications: Array<(method: string, params: unknown) => void> = []
  #nextId = 1

  constructor(send: (message: JsonRpcMessage) => void) {
    this.#send = send
  }

  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    const id = this.#nextId
    this.#nextId += 1

    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new JsonRpcTimeoutError(`${method}: aborted before send`))
        return
      }

      const onAbort = (): void => {
        if (this.#pending.delete(id)) reject(new JsonRpcTimeoutError(`${method}: aborted`))
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(value as T)
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort)
          reject(error)
        },
        detach: () => signal?.removeEventListener("abort", onAbort),
      })

      try {
        this.#send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
      } catch (error: unknown) {
        const entry = this.#pending.get(id)
        this.#pending.delete(id)
        entry?.detach()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.#send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.#notifications.push(handler)
  }

  /**
   * Feed one decoded message. Responses are matched by id; a response with no matching pending entry
   * is dropped rather than thrown, because a call that already timed out still gets its reply, and
   * that is not an error worth killing a server over.
   */
  handle(message: JsonRpcMessage): void {
    const hasId = "id" in message && message.id !== undefined && message.id !== null
    const hasMethod = typeof (message as { method?: unknown }).method === "string"

    if (hasId && !hasMethod) {
      const id = Number(message.id)
      const entry = this.#pending.get(id)
      if (!entry) return
      this.#pending.delete(id)
      entry.detach()
      if ("error" in message) {
        const error = new JsonRpcError(message.error)
        entry.reject(error)
      } else {
        entry.resolve(("result" in message ? message.result : undefined) ?? null)
      }
      return
    }

    if (hasMethod) {
      const method = (message as { method: string }).method
      const params = (message as { params?: unknown }).params
      if (hasId) {
        // Servers may call back into the client. We expose no client features, so answering
        // "method not found" is the honest reply - better than silence and a hung server.
        this.#send({
          jsonrpc: "2.0",
          id: message.id as number | string,
          error: { code: -32601, message: `method not found: ${method}` },
        })
        return
      }
      for (const handler of this.#notifications) {
        try {
          handler(method, params)
        } catch {
          // A notification handler is a listener, not part of the protocol. Never let it break the
          // reader loop that is also carrying responses.
        }
      }
    }
  }

  /** Fail every in-flight request. Called when the pipe closes or the transport gives up. */
  rejectAll(reason: string): void {
    const entries = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of entries) {
      entry.detach()
      entry.reject(new Error(reason))
    }
  }

  get pendingCount(): number {
    return this.#pending.size
  }
}

export class JsonRpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(error: JsonRpcErrorBody) {
    super(error.message || `json-rpc error ${error.code}`)
    this.name = "JsonRpcError"
    this.code = error.code
    this.data = error.data
  }
}
