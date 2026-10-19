import type { Tool, ToolResult } from "./types.ts"
import { argNumber, argString } from "./args.ts"
import { runCommand } from "../sandbox/exec.ts"
import { hasBubblewrap } from "../sandbox/detect.ts"

export const shellTool: Tool = {
  name: "shell",
  description:
    "Run a shell command in the working directory. Runs inside the sandbox, so the network, " +
    "filesystem and process limits come from policy - a denied command is refused, not retried. " +
    "Returns stdout, stderr and the exit code.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run via /bin/sh -c." },
      timeoutMs: { type: "integer", description: "Optional wall-clock timeout in milliseconds." },
    },
    required: ["command"],
  },

  async run(args, context): Promise<ToolResult> {
    const command = argString(args, "command")
    if (!command || command.trim().length === 0) return { ok: false, content: "missing required argument: command" }

    const timeoutMs = argNumber(args, "timeoutMs") ?? undefined
    const result = await runCommand(context.policy, command, {
      cwd: context.cwd,
      signal: context.signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })

    const parts: string[] = []
    if (result.note) parts.push(`[${result.note}]`)
    if (!context.policy.enabled && !hasBubblewrap()) parts.push("[no sandbox available]")
    if (result.stdout.trim().length > 0) parts.push(result.stdout.trimEnd())
    if (result.stderr.trim().length > 0) parts.push(`stderr:\n${result.stderr.trimEnd()}`)
    if (result.timedOut) parts.push(`[timed out after ${timeoutMs ?? context.policy.limits.wallClockMs} ms]`)
    if (result.exitCode !== null && result.exitCode !== 0) parts.push(`[exit code ${result.exitCode}]`)
    if (parts.length === 0) parts.push("[no output]")

    return {
      ok: result.ok,
      content: parts.join("\n"),
      meta: {
        exitCode: result.exitCode,
        sandboxed: result.sandboxed,
        timedOut: result.timedOut,
      },
    }
  },
}
