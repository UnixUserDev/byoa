import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { JsonRpc } from "./jsonrpc.ts"
import type { JsonRpcMessage } from "./jsonrpc.ts"
import type { McpTransport } from "./types.ts"

/**
 * Environment variables a well-behaved MCP server needs to exist at all.
 *
 * The parent environment is deliberately not inherited: byoa's own process holds API keys, and an
 * MCP server that reads `OPENAI_API_KEY` out of the environment by accident is an exfiltration path
 * nobody asked for. A server that needs a secret gets it named explicitly in `env`.
 */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "SystemRoot",
  "COMSPEC",
] as const

/**
 * Names a server's `env` block may not set.
 *
 * A child spawned with `LD_PRELOAD` or `NODE_OPTIONS` runs code the user never approved, and one
 * with a rewritten `PATH` runs a different binary than the one in the config. The shell tool
 * already scrubs these (see `DEFAULT_POLICY.env.scrub`); the MCP path has to as well, or the
 * scrubbing is only true for the tools the sandbox covers.
 */
const RESERVED_ENV = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYOPT",
  "PERL5OPT",
  "BASH_ENV",
  "SHELLOPTS",
  "GLIBC_TUNABLES",
  // Java is the most common stdio MCP runtime, and these are the canonical agent-injection knobs.
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "CLASSPATH",
  "PERL5LIB",
  "RUBYLIB",
])

/** No single frame may exceed this. A server that streams without a boundary is not a server. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_HEADER_BYTES = 4 * 1024

export interface StdioTransportOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  /** How much of stderr to keep for error messages. */
  stderrBytes?: number
}

export function childEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of INHERITED_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (RESERVED_ENV.has(name)) continue
    env[name] = value
  }
  return env
}

/**
 * Newline-delimited JSON-RPC over a child's stdin/stdout.
 *
 * The MCP spec says one JSON message per line. A meaningful minority of servers speak LSP-style
 * `Content-Length:` framing instead, so the reader accepts both rather than refusing to talk to
 * half the ecosystem. Framing is re-detected per frame: a stream that starts with a header is read
 * as header-framed, and a bare line is read as a line.
 */
export class StdioTransport implements McpTransport {
  readonly #name: string
  readonly #onClose: Array<(reason: string) => void> = []
  readonly #rpc: JsonRpc
  readonly #child: ChildProcess
  readonly #stderrLimit: number
  #stderr = ""
  #stdinError: string | null = null
  #buffer: Buffer = Buffer.alloc(0)
  #closed = false

  constructor(name: string, options: StdioTransportOptions) {
    this.#name = name
    this.#stderrLimit = options.stderrBytes ?? 4_096
    this.#rpc = new JsonRpc((message) => this.#write(message))

    this.#child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: childEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      // Not detached: this process owns the server's lifetime, and a server that outlives byoa is a
      // leak with an open pipe back into a process that no longer exists.
      detached: false,
    })

    this.#child.stdout?.on("data", (chunk: Buffer) => this.#onData(chunk))
    this.#child.stdout?.on("error", () => this.#shutdown("stdout pipe failed"))
    this.#child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-this.#stderrLimit)
    })
    // A write to a child that has already exited fails asynchronously with EPIPE on the socket.
    // Unhandled, that is an uncaught 'error' event and the entire harness dies - so a server that
    // crashes mid-request would take byoa with it. Handle it as what it is: the server is gone.
    //
    // The pipe error arrives before `close`, which is where the stderr tail lives, so this waits a
    // moment for close to produce the better reason instead of reporting a bare EPIPE.
    this.#child.stdin?.on("error", (error: Error) => {
      this.#stdinError = `stdin pipe failed: ${error.message}`
      const timer = setTimeout(() => this.#shutdown(this.#stdinError ?? "stdin pipe failed"), 250)
      this.#child.once("close", () => clearTimeout(timer))
    })
    this.#child.on("error", (error: Error) => this.#shutdown(`failed to start: ${error.message}`))
    // `close`, not `exit`: close fires after the stdio streams are drained, so the stderr tail that
    // explains *why* the server died is actually available to report.
    this.#child.on("close", (code, signal) => {
      const how = signal === null ? `exit ${code ?? "?"}` : `signal ${signal}`
      this.#shutdown(`server ${how}`)
    })
  }

  get stderr(): string {
    return this.#stderr.trim()
  }

  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(`mcp ${this.#name}: server is not running`))
    return this.#rpc.request<T>(method, params, signal)
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return
    this.#rpc.notify(method, params)
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.#rpc.onNotification(handler)
  }

  onClose(handler: (reason: string) => void): void {
    this.#onClose.push(handler)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#rpc.rejectAll(`mcp ${this.#name}: closed`)
    this.#child.stdin?.end()
    const child = this.#child
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve()
      }, 2_000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill("SIGTERM")
    })
  }

  #shutdown(reason: string): void {
    if (this.#closed) return
    this.#closed = true
    // One string for both audiences: the pending requests and the close listeners. Building the
    // stderr tail only for the listeners left every failed call reporting a bare "server exit 1"
    // with the actual reason sitting unread in the buffer.
    const detail = this.#stderr.length > 0 ? ` (stderr: ${this.#stderr.split("\n").slice(-3).join(" | ")})` : ""
    const message = `${reason}${detail}`
    this.#rpc.rejectAll(`mcp ${this.#name}: ${message}`)
    for (const handler of this.#onClose) {
      try {
        handler(message)
      } catch {
        // A listener must not be able to break the shutdown path.
      }
    }
  }

  #write(message: JsonRpcMessage): void {
    if (this.#closed) throw new Error(`mcp ${this.#name}: server is not running`)
    const stdin = this.#child.stdin
    if (!stdin || stdin.destroyed) throw new Error(`mcp ${this.#name}: stdin is closed`)
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    if (this.#buffer.length > MAX_FRAME_BYTES) {
      // Without this, a server that never emits a boundary grows the buffer (and the copy on every
      // chunk) until the process dies. That is a DoS with one line of JavaScript.
      this.#shutdown(`framing error: a single message exceeded ${MAX_FRAME_BYTES} bytes`)
      return
    }

    for (;;) {
      const frame = this.#takeFrame()
      if (frame === null) return
      const text = frame.toString("utf8").trim()
      if (text.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        // A server writing log lines to stdout instead of stderr is common and not fatal. Dropping
        // the line keeps the reader alive; the JSON-RPC calls will time out with a real error.
        continue
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      for (const message of messages) {
        if (message !== null && typeof message === "object") this.#rpc.handle(message as JsonRpcMessage)
      }
    }
  }

  #takeFrame(): Buffer | null {
    // Tolerate blank lines between frames.
    while (this.#buffer.length > 0) {
      const first = this.#buffer[0]
      if (first === 0x0a || first === 0x0d) this.#buffer = this.#buffer.subarray(1)
      else break
    }
    if (this.#buffer.length === 0) return null

    const head = this.#buffer.subarray(0, 32).toString("latin1")
    if (/^content-length\s*:/i.test(head)) {
      const prefix = this.#buffer.subarray(0, MAX_HEADER_BYTES).toString("latin1")
      // `\r?\n\r?\n` covers CRLF, LF, and the mixed case where LF header lines are terminated by
      // a CRLF blank line - which a strict indexOf of either separator misses forever.
      const boundary = /\r?\n\r?\n/.exec(prefix)
      if (!boundary) {
        if (this.#buffer.length > MAX_HEADER_BYTES) {
          this.#shutdown("framing error: header block did not terminate")
        }
        return null
      }
      const match = /content-length\s*:\s*(\d+)/i.exec(prefix.slice(0, boundary.index))
      if (!match) {
        // Unparseable header: drop it rather than wedging the reader forever.
        this.#buffer = this.#buffer.subarray(boundary.index + boundary[0].length)
        return null
      }
      const length = Number(match[1])
      if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
        this.#shutdown(`framing error: declared Content-Length ${match[1]} is not usable`)
        return null
      }
      const start = boundary.index + boundary[0].length
      if (this.#buffer.length < start + length) return null
      const body = this.#buffer.subarray(start, start + length)
      this.#buffer = this.#buffer.subarray(start + length)
      return body
    }

    const newline = this.#buffer.indexOf(0x0a)
    if (newline === -1) return null
    const line = this.#buffer.subarray(0, newline)
    this.#buffer = this.#buffer.subarray(newline + 1)
    return line
  }
}
