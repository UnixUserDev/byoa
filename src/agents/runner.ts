import { Agent } from "../core/agent.ts"
import type { AgentPersistence } from "../core/agent.ts"
import type { Provider } from "../providers/types.ts"
import type { ToolRegistry } from "../tools/registry.ts"
import type { SandboxPolicy } from "../sandbox/policy.ts"
import type { TierId } from "../prompts/tiers.ts"
import type { CreateSessionInput, SessionRecord } from "../store/sessions.ts"
import { titleFrom } from "../store/sessions.ts"
import type { AgentSpec, RunBudget, SubagentFinish, SubagentResult } from "./types.ts"

/** The slice of the session store a child run needs. `SqliteSessionStore` satisfies it as-is. */
export interface SessionSink {
  create(input: CreateSessionInput): SessionRecord
  toPersistence(sessionId: string): AgentPersistence
}

export interface SubagentRunnerOptions {
  store: SessionSink
  provider: Provider
  model: string
  tier: TierId
  tools: ToolRegistry
  policy: SandboxPolicy
  cwd: string
  /** Parent's approval mode. "auto" children run unattended; "ask" children ask through the parent. */
  approvalMode: "auto" | "ask"
  resolveProvider?: (providerId: string) => Provider | undefined
}

export interface RunSubagentOptions {
  signal: AbortSignal
  /** The delegating session, so a child is reachable from `byoa sessions --tree`. */
  parentSessionId: string
  /** Depth of the parent that is delegating. The child runs at `depth + 1`. */
  depth: number
  /**
   * The parent tool's approval channel. A child with `ask` reaches a human through this, because
   * the child's own bus is drained internally and nothing is rendering it.
   */
  requestApproval(request: { kind: "tool" | "net" | "fs"; detail: unknown }): Promise<boolean>
}

const SUMMARY_LIMIT = 20_000

/**
 * Runs one child agent and returns only its final answer.
 *
 * Why a fresh `Agent` rather than re-entering the parent's loop: the parent's loop is single-turn
 * (`#submit` refuses while `#running`) and its event queue is single-consumer, so nesting would
 * either deadlock or silently steal events from the frontend.
 */
export class SubagentRunner {
  readonly #options: SubagentRunnerOptions

  constructor(options: SubagentRunnerOptions) {
    this.#options = options
  }

  async run(spec: AgentSpec, task: string, budget: RunBudget, runOptions: RunSubagentOptions): Promise<SubagentResult> {
    const depth = runOptions.depth + 1
    const { provider, model } = this.#target(spec)
    const tier = spec.tier ?? this.#options.tier
    const tools = this.#toolsFor(spec, depth, budget.maxDepth)

    const record = this.#options.store.create({
      title: titleFrom(`[${spec.name}] ${task}`),
      provider: provider.id,
      model,
      tier,
      cwd: this.#options.cwd,
      policy: this.#options.policy,
      parentId: runOptions.parentSessionId,
    })

    const child = new Agent({
      provider,
      model,
      tier,
      tools,
      policy: this.#options.policy,
      cwd: this.#options.cwd,
      id: record.id,
      title: record.title,
      maxSteps: budget.maxSteps,
      // Children get no vault access: an auto-recalled note about the user's unrelated project is
      // noise in a focused run, and memory tools would let a child write outside its remit.
      memory: null,
      persistence: this.#options.store.toPersistence(record.id),
      approvalMode: this.#options.approvalMode,
      ...(this.#options.resolveProvider ? { resolveProvider: this.#options.resolveProvider } : {}),
      systemSuffix: spec.prompt,
      depth,
    })

    return await this.#drive(child, task, budget, runOptions)
  }

  async #drive(
    child: Agent,
    task: string,
    budget: RunBudget,
    runOptions: RunSubagentOptions,
  ): Promise<SubagentResult> {
    let summary = ""
    let segment = ""
    let finishReason: SubagentFinish = "stop"
    let steps = 0
    let tokensIn = 0
    let tokensOut = 0
    let abandoned = false
    let fatal = false

    const onAbort = (): void => {
      child.send({ t: "cancel" })
    }
    runOptions.signal.addEventListener("abort", onAbort, { once: true })

    const draining = (async (): Promise<void> => {
      for await (const event of child.events()) {
        if (event.t === "text") {
          segment += event.delta
          continue
        }
        if (event.t === "approval.request") {
          // Forward to the parent's human. Deliberately not awaited here: the child is blocked on the
          // answer, and the loop must keep draining so `turn.end` can still arrive.
          void runOptions
            .requestApproval({ kind: event.kind, detail: event.detail })
            .then((allow) => child.send({ t: "approve", id: event.id, allow }))
            .catch(() => child.send({ t: "approve", id: event.id, allow: false }))
          continue
        }
        if (event.t === "tool.call") {
          // A new assistant message starts after a tool call, so the previous text was commentary.
          // Keeping only the last segment is what makes the summary an answer, not a transcript.
          if (segment.trim().length > 0) summary = segment
          segment = ""
          continue
        }
        if (event.t === "usage") {
          steps += 1
          tokensIn += event.turnInput
          tokensOut += event.turnOutput
          if (budget.maxTokens !== undefined && tokensOut > budget.maxTokens) {
            abandoned = true
            child.send({ t: "cancel" })
          }
          continue
        }
        if (event.t === "turn.end") {
          // A fatal error the child emitted (no usable sandbox, for instance) outranks the
          // agent loop's own verdict, which would otherwise report a clean "stop".
          finishReason = fatal ? "error" : event.finishReason
          break
        }
        if (event.t === "error" && event.fatal) {
          fatal = true
        }
      }
    })()

    try {
      child.send({ t: "submit", text: task })
      await draining
    } finally {
      // Runs even if the drain loop throws (a synchronous throw from the approval channel, say):
      // a leaked child would hold a live provider request and an abort listener forever.
      runOptions.signal.removeEventListener("abort", onAbort)
      await child.dispose()
    }

    if (segment.trim().length > 0) summary = segment
    const finalSummary = summary.trim()

    const cut: SubagentResult["summary"] =
      finalSummary.length > SUMMARY_LIMIT ? `${finalSummary.slice(0, SUMMARY_LIMIT)}\n[... summary truncated]` : finalSummary

    return {
      ok: finishReason === "stop" && !abandoned,
      childSessionId: child.id,
      task,
      summary:
        cut.length > 0
          ? cut
          : abandoned
            ? "(stopped: the run exceeded its output-token budget before answering)"
            : "(the child produced no answer)",
      finishReason: abandoned ? "cancelled" : finishReason,
      steps,
      tokensIn,
      tokensOut,
    }
  }

  /**
   * Resolve `provider/model` for a child.
   *
   * A preset that names a provider we cannot build is an error, not a fallback: quietly running
   * `claude-3` on the OpenAI provider would be a wrong answer that looks like a right one.
   */
  #target(spec: AgentSpec): { provider: Provider; model: string } {
    if (!spec.model) return { provider: this.#options.provider, model: this.#options.model }
    const slash = spec.model.indexOf("/")
    if (slash <= 0) return { provider: this.#options.provider, model: spec.model }
    const providerId = spec.model.slice(0, slash)
    const provider = this.#options.resolveProvider?.(providerId)
    if (!provider) {
      throw new Error(`agent '${spec.name}' asks for provider '${providerId}', which is not configured`)
    }
    return { provider, model: spec.model.slice(slash + 1) }
  }

  #toolsFor(spec: AgentSpec, depth: number, maxDepth: number): ToolRegistry {
    const base = spec.tools ? this.#options.tools.pick(spec.tools) : this.#options.tools
    // The hard stop on runaway recursion. Depth is carried on the tool context, but a child that
    // never gets the `task` tool at all cannot even try.
    return depth >= maxDepth ? base.without(["task"]) : base
  }
}

/** Type guard used by the task tool so a plugin cannot smuggle in a bad preset name. */
export function isAgentSpec(value: unknown): value is AgentSpec {
  if (value === null || typeof value !== "object") return false
  const candidate = value as Partial<AgentSpec>
  return typeof candidate.name === "string" && typeof candidate.prompt === "string" && candidate.prompt.length > 0
}
