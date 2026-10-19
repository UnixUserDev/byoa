import { spawn } from "node:child_process"
import type { SandboxPolicy } from "./policy.ts"
import { limitPreamble } from "./policy.ts"
import { compileCommand } from "./compile.ts"
import { unwrappedEnvironment } from "./envscrub.ts"
import { hasBubblewrap } from "./detect.ts"

export interface ExecOptions {
  cwd: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  input?: string
  maxOutputBytes?: number
  /**
   * Cancel the command. Without this, `/cancel` during a five-minute build did nothing at all
   * until the wall-clock timeout - the tool held the turn open and the UI looked hung.
   */
  signal?: AbortSignal
}

export interface ExecResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  sandboxed: boolean
  note?: string
}

const DEFAULT_MAX_OUTPUT = 1_000_000

export function runCommand(
  policy: SandboxPolicy,
  command: string,
  options: ExecOptions,
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? policy.limits.wallClockMs ?? 120_000
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT

  const available = hasBubblewrap()
  const compiled = compileCommand(policy, {
    cwd: options.cwd,
    command,
    ...(options.env === undefined ? {} : { env: options.env }),
  })

  if (compiled.deniedReason) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: compiled.deniedReason,
      exitCode: null,
      timedOut: false,
      sandboxed: false,
    })
  }

  // Fail closed: if the policy demands a sandbox and we cannot provide one, refuse to run at all
  // rather than pretending isolation happened.
  if (policy.enabled && policy.strict && (!available || !compiled.sandboxed)) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "refusing to run: sandbox is required (strict) but bubblewrap is unavailable",
      exitCode: null,
      timedOut: false,
      sandboxed: false,
    })
  }

  const degraded = policy.enabled && !available
  const argv = degraded
    ? ["/bin/sh", "-c", `${limitPreamble(policy)}${command}`]
    : compiled.argv
  // Only the paths that are NOT inside bubblewrap need an environment handed to spawn. Those get
  // the same allowlist the sandboxed path gets - the old four-variable `LD_*` denylist left every
  // API key in the model-driven shell.
  const wrapped = compiled.sandboxed && !degraded
  const env = wrapped ? undefined : unwrappedEnvironment(policy, options.env ?? process.env)

  return new Promise<ExecResult>((resolve) => {
    // `detached` puts the child in its own process group, so a timeout or a cancel can kill the
    // whole tree. Killing only the direct child leaves a backgrounded grandchild holding the pipes
    // open, and the promise would never settle.
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: options.cwd,
      ...(env === undefined ? {} : { env }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    })

    let stdout = ""
    let stderr = ""
    let stdoutCapped = false
    let stderrCapped = false
    let timedOut = false
    let settled = false

    const killTree = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)

    const onAbort = (): void => {
      killTree()
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (options.signal?.aborted === true) killTree()

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      const cancelled = options.signal?.aborted === true && !timedOut
      const notes: string[] = []
      if (compiled.degradedReason) notes.push(compiled.degradedReason)
      if (degraded) notes.push("bubblewrap unavailable - ran unwrapped")
      if (cancelled) notes.push("cancelled")
      if (stdoutCapped || stderrCapped) notes.push(`output truncated at ${maxOutput} bytes per stream`)
      const result: ExecResult = {
        ok: exitCode === 0 && !timedOut && !cancelled,
        stdout,
        stderr,
        exitCode,
        timedOut,
        sandboxed: compiled.sandboxed && !degraded && available,
        ...(notes.length === 0 ? {} : { note: notes.join("; ") }),
      }
      resolve(result)
    }

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const current = target === "stdout" ? stdout : stderr
      if (current.length >= maxOutput) {
        if (target === "stdout") stdoutCapped = true
        else stderrCapped = true
        return
      }
      // Cut the chunk at the ceiling instead of overshooting it, and remember that we did.
      const text = chunk.toString("utf8")
      const room = maxOutput - current.length
      const slice = text.length > room ? text.slice(0, room) : text
      if (text.length > room) {
        if (target === "stdout") stdoutCapped = true
        else stderrCapped = true
      }
      if (target === "stdout") stdout += slice
      else stderr += slice
    }

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk))
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk))

    child.on("error", (error: Error) => {
      stderr += `${error.message}\n`
      finish(null)
    })
    child.on("close", (code: number | null) => finish(code))

    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
  })
}
