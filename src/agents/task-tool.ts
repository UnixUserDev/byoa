import type { Tool, ToolResult } from "../tools/types.ts"
import { isAgentSpec } from "./runner.ts"
import type { SubagentRunner } from "./runner.ts"
import type { AgentSpec, RunBudget } from "./types.ts"

const DEFAULT_PROMPT = `You are a focused subagent working on one delegated task.
You cannot ask the user anything: do the work with the tools you have and answer with the result.
Your reply is the only thing the delegating agent will see, so state the outcome plainly, name the
files you touched, and say what you verified. Do not narrate your process.`

export interface TaskToolOptions {
  runner: SubagentRunner
  /** Named agents from plugins (and, later, from config). */
  presets: AgentSpec[]
  /** Absolute nesting ceiling, from config. */
  maxDepth: number
  /** Step cap for a child, from config. A caller may ask for fewer, never more. */
  maxSteps: number
  /** Output-token ceiling for a child, from config. */
  maxTokens?: number
}

interface TaskArgs {
  task: string
  agent?: string
  prompt?: string
  tools?: string[]
  maxSteps?: number
}

function parseArgs(args: unknown): TaskArgs | string {
  if (args === null || typeof args !== "object") return "expected an object"
  const raw = args as Record<string, unknown>
  if (typeof raw.task !== "string" || raw.task.trim().length === 0) return "task must be a non-empty string"
  if (raw.agent !== undefined && typeof raw.agent !== "string") return "agent must be a string"
  if (raw.prompt !== undefined && typeof raw.prompt !== "string") return "prompt must be a string"
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools) || raw.tools.some((name) => typeof name !== "string")) {
      return "tools must be an array of tool names"
    }
  }
  if (raw.maxSteps !== undefined && typeof raw.maxSteps !== "number") return "maxSteps must be a number"

  return {
    task: raw.task,
    ...(typeof raw.agent === "string" ? { agent: raw.agent } : {}),
    ...(typeof raw.prompt === "string" ? { prompt: raw.prompt } : {}),
    ...(Array.isArray(raw.tools) ? { tools: raw.tools as string[] } : {}),
    ...(typeof raw.maxSteps === "number" ? { maxSteps: raw.maxSteps } : {}),
  }
}

/**
 * The `task` tool: delegation for the model.
 *
 * `mutating: false` is deliberate. The tool itself only reads and reasons; what actually touches the
 * disk are the child's own tools, which carry their own `mutating` flags and hit the same approval
 * gate. Marking `task` as mutating would double-gate the harmless case and still not cover the
 * child's inner tools.
 */
export function createTaskTool(options: TaskToolOptions): Tool {
  const presets = new Map(options.presets.filter(isAgentSpec).map((spec) => [spec.name, spec]))

  return {
    name: "task",
    description:
      "Delegate a self-contained job to a subagent with its own context. Use it for work that needs many steps " +
      "but whose intermediate output you do not need - searching, reading, drafting. The subagent returns a " +
      "summary only; it does not share your conversation. Pass `agent` to pick a named preset" +
      (presets.size > 0 ? ` (${[...presets.keys()].join(", ")})` : "") +
      ".",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the subagent must do, stated as a complete instruction." },
        agent: { type: "string", description: "Named agent preset to run as." },
        prompt: { type: "string", description: "Extra instructions for this run, when not using a preset." },
        tools: { type: "array", items: { type: "string" }, description: "Restrict the subagent to these tools." },
        maxSteps: { type: "integer", description: "Step budget for the subagent." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    validate: (args) => {
      const parsed = parseArgs(args)
      return typeof parsed === "string" ? parsed : null
    },
    async run(args: unknown, context): Promise<ToolResult> {
      const parsed = parseArgs(args)
      if (typeof parsed === "string") return { ok: false, content: `invalid arguments: ${parsed}` }

      const depth = context.depth ?? 0
      if (depth >= options.maxDepth) {
        return {
          ok: false,
          content: `refusing to delegate: this run is already at depth ${depth} of ${options.maxDepth}. Do the task yourself.`,
        }
      }

      let spec: AgentSpec
      if (parsed.agent !== undefined) {
        const preset = presets.get(parsed.agent)
        if (!preset) {
          const known = [...presets.keys()]
          return {
            ok: false,
            content:
              known.length === 0
                ? `no agent preset named '${parsed.agent}' - none are configured, so call task without 'agent'`
                : `no agent preset named '${parsed.agent}' - known: ${known.join(", ")}`,
          }
        }
        spec = parsed.prompt === undefined ? preset : { ...preset, prompt: `${preset.prompt}\n\n${parsed.prompt}` }
        if (parsed.tools) spec = { ...spec, tools: parsed.tools }
      } else {
        spec = {
          name: "subagent",
          prompt: parsed.prompt ?? DEFAULT_PROMPT,
          ...(parsed.tools ? { tools: parsed.tools } : {}),
        }
      }

      // A caller may lower the step budget, never raise it past what the operator configured.
      const requestedSteps = parsed.maxSteps ?? options.maxSteps
      const budget: RunBudget = {
        maxSteps: Math.max(1, Math.min(Math.floor(requestedSteps), options.maxSteps)),
        maxDepth: options.maxDepth,
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      }

      const result = await options.runner.run(spec, parsed.task, budget, {
        signal: context.signal,
        depth,
        parentSessionId: context.sessionId ?? "",
        requestApproval: context.requestApproval,
      })

      const stats = `${result.finishReason}, ${result.steps} step(s), ${result.tokensIn}/${result.tokensOut} tokens, session ${result.childSessionId}`
      return {
        ok: result.ok,
        content: `${result.summary}\n\n[subagent: ${stats}]`,
        meta: {
          childSessionId: result.childSessionId,
          finishReason: result.finishReason,
          steps: result.steps,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
        },
      }
    },
  }
}
