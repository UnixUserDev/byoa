import type { AgentEvent, AgentHandle } from "../../core/events.ts"
import { createApp } from "./app.ts"

/**
 * The only module that loads OpenTUI at runtime.
 *
 * Everything else in this directory is pure and importable without the native FFI, so the smoke
 * test, the CLI and a machine without the optional dependency keep working.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface TuiEnv {
  requested: boolean
  stdinTTY: boolean
  stdoutTTY: boolean
  term?: string
  noColor: boolean
}

export function shouldUseTui(env: TuiEnv): { ok: true } | { ok: false; reason: string } {
  if (!env.requested) return { ok: false, reason: "not requested" }
  if (!env.stdinTTY || !env.stdoutTTY) return { ok: false, reason: "not a terminal" }
  if (env.term === "dumb") return { ok: false, reason: "TERM=dumb" }
  if (env.noColor) return { ok: false, reason: "NO_COLOR is set" }
  return { ok: true }
}

export interface RunTuiOptions {
  /** Submit once, then exit after the turn ends (used with -p). */
  prompt?: string
  onSessionChange?: (info: { provider: string; model: string; tier: string }) => void
}

export async function runTui(agent: AgentHandle, options: RunTuiOptions = {}): Promise<number> {
  const kit: any = await import("@opentui/core")
  const renderer = await kit.createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    useMouse: false,
    targetFps: 30,
    clearOnShutdown: true,
  })

  let quitting = false
  let lastFinish = "stop"

  const quit = (): void => {
    if (quitting) return
    quitting = true
    agent.send({ t: "cancel" })
    void agent.dispose()
  }

  const app = createApp({
    agent,
    kit,
    renderer,
    width: renderer.width,
    height: renderer.height,
    onQuit: quit,
    ...(options.onSessionChange === undefined ? {} : { onSessionChange: options.onSessionChange }),
  })

  renderer.root.add(app.root)

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
  const onSignal = (): void => quit()
  for (const signal of signals) process.on(signal, onSignal)

  // A throw from a timer or a key handler would otherwise leave the terminal in raw mode. Restore
  // first, then exit non-zero.
  const fatal = (error: unknown): void => {
    try {
      app.dispose()
      renderer.destroy()
    } catch {
      // Best effort: the original error is the useful one.
    }
    process.stderr.write(`byoa: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    void renderer.closed.finally(() => process.exit(1))
    setTimeout(() => process.exit(1), 500)
  }
  process.on("uncaughtException", fatal)
  process.on("unhandledRejection", fatal)

  if (options.prompt !== undefined) {
    agent.send({ t: "submit", text: options.prompt })
  }

  try {
    for await (const event of agent.events() as AsyncIterable<AgentEvent>) {
      app.handleEvent(event)
      if (event.t === "turn.end") {
        lastFinish = event.finishReason
        if (options.prompt !== undefined) quit()
      }
    }
  } finally {
    app.dispose()
    renderer.destroy()
    await renderer.closed
    for (const signal of signals) process.off(signal, onSignal)
    process.off("uncaughtException", fatal)
    process.off("unhandledRejection", fatal)
    await agent.dispose()
  }

  return options.prompt === undefined ? 0 : lastFinish === "stop" ? 0 : 1
}
