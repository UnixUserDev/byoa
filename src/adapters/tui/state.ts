import type { AgentEvent } from "../../core/events.ts"
import type { RecallHit } from "../../memory/types.ts"
import { sandboxBadge } from "./format.ts"

/**
 * The TUI's state is plain data, reduced from the event stream. No OpenTUI import lives here (the
 * types are `import type`), so this file is testable without the native FFI and without a terminal.
 */

export type Mode = "idle" | "running" | "approval"

export interface UserBlock {
  kind: "user"
  id: number
  text: string
}
export interface AssistantBlock {
  kind: "assistant"
  id: number
  text: string
}
export interface ReasoningBlock {
  kind: "reasoning"
  id: number
  text: string
}
export interface ToolBlock {
  kind: "tool"
  id: number
  callId: string
  name: string
  summary: string
  ok: boolean | null
  durationMs?: number
  content?: string
}
export interface MemoryBlock {
  kind: "memory"
  id: number
  text: string
}
export interface NoticeBlock {
  kind: "notice"
  id: number
  level: "info" | "warn" | "error"
  text: string
}

export type Block = UserBlock | AssistantBlock | ReasoningBlock | ToolBlock | MemoryBlock | NoticeBlock

export interface Approval {
  id: string
  kind: "tool" | "net" | "fs"
  summary: string
}

export interface TuiState {
  session: { id: string; title: string; provider: string; model: string; tier: string; cwd: string }
  sandbox: { applied: boolean; degraded: boolean; reason?: string; badge: string }
  mode: Mode
  turn: {
    n: number
    startedAt: number | null
    endedAt: number | null
    in: number
    out: number
    tools: number
    toolFails: number
    memHits: number
    memWrites: number
  }
  usage: { sessionIn: number; sessionOut: number }
  blocks: Block[]
  /** callId -> block id, for O(1) tool-result updates. */
  callIndex: Record<string, number>
  callStarted: Record<string, number>
  approvals: Approval[]
  pendingSubmit: string | null
  ui: { reasoningVisible: boolean; lastError?: string }
  nextId: number
}

export function initialState(): TuiState {
  return {
    session: { id: "", title: "", provider: "", model: "", tier: "normal", cwd: "" },
    sandbox: { applied: true, degraded: false, badge: "sandbox" },
    mode: "idle",
    turn: { n: 0, startedAt: null, endedAt: null, in: 0, out: 0, tools: 0, toolFails: 0, memHits: 0, memWrites: 0 },
    usage: { sessionIn: 0, sessionOut: 0 },
    blocks: [],
    callIndex: {},
    callStarted: {},
    approvals: [],
    pendingSubmit: null,
    ui: { reasoningVisible: false },
    nextId: 1,
  }
}

export type Effect =
  | { t: "header" }
  | { t: "stats" }
  | { t: "block.add"; block: Block }
  | { t: "block.append"; id: number; text: string }
  | { t: "block.replace"; block: Block }
  | { t: "block.trim"; keep: number }
  | { t: "approval" }
  | { t: "mode" }
  | { t: "scroll" }
  | { t: "input.clear" }
  | { t: "submit"; text: string }
  | { t: "quit" }

const MAX_BLOCKS = 400

function add(state: TuiState, block: Omit<Block, "id"> & { id?: number }): { block: Block; state: TuiState } {
  const id = state.nextId
  const full = { ...block, id } as Block
  const blocks = [...state.blocks, full]
  return {
    block: full,
    state: {
      ...state,
      blocks: blocks.length > MAX_BLOCKS ? blocks.slice(blocks.length - MAX_BLOCKS) : blocks,
      nextId: id + 1,
    },
  }
}

function lastOpen(state: TuiState, kind: "assistant" | "reasoning"): Block | undefined {
  const last = state.blocks.at(-1)
  return last && last.kind === kind ? last : undefined
}

export interface ReduceResult {
  state: TuiState
  effects: Effect[]
}

export function reduce(state: TuiState, event: AgentEvent, now: number): ReduceResult {
  const effects: Effect[] = []
  switch (event.t) {
    case "session.info": {
      const next: TuiState = {
        ...state,
        session: {
          id: event.id,
          title: event.title,
          provider: event.provider,
          model: event.model,
          tier: event.tier,
          cwd: event.cwd,
        },
      }
      effects.push({ t: "header" })
      return { state: next, effects }
    }

    case "sandbox.info": {
      const badge = sandboxBadge(event.applied, event.degraded)
      const next: TuiState = {
        ...state,
        sandbox: {
          applied: event.applied,
          degraded: event.degraded,
          badge,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        },
      }
      return { state: next, effects }
    }

    case "turn.start": {
      const next: TuiState = {
        ...state,
        mode: "running",
        usage: { ...state.usage },
        turn: {
          n: event.turn,
          startedAt: now,
          endedAt: null,
          in: 0,
          out: 0,
          tools: 0,
          toolFails: 0,
          memHits: 0,
          memWrites: 0,
        },
      }
      effects.push({ t: "stats" })
      return { state: next, effects }
    }

    case "text": {
      const open = lastOpen(state, "assistant")
      if (open) {
        const next = { ...state, blocks: state.blocks.map((b) => (b.id === open.id ? { ...b, text: b.text + event.delta } : b)) }
        effects.push({ t: "block.append", id: open.id, text: event.delta })
        return { state: next, effects }
      }
      const { block, state: next } = add(state, { kind: "assistant", text: event.delta })
      effects.push({ t: "block.add", block })
      effects.push({ t: "scroll" })
      return { state: next, effects }
    }

    case "reasoning": {
      const open = lastOpen(state, "reasoning")
      if (open) {
        const next = { ...state, blocks: state.blocks.map((b) => (b.id === open.id ? { ...b, text: b.text + event.delta } : b)) }
        effects.push({ t: "block.append", id: open.id, text: event.delta })
        return { state: next, effects }
      }
      const { block, state: next } = add(state, { kind: "reasoning", text: event.delta })
      effects.push({ t: "block.add", block })
      return { state: next, effects }
    }

    case "tool.call": {
      const { block, state: next } = add(state, {
        kind: "tool",
        callId: event.id,
        name: event.name,
        summary: "",
        ok: null,
      })
      const withIndex: TuiState = {
        ...next,
        callIndex: { ...next.callIndex, [event.id]: block.id },
        callStarted: { ...next.callStarted, [event.id]: now },
        turn: { ...next.turn, tools: next.turn.tools + 1 },
      }
      effects.push({ t: "block.add", block })
      effects.push({ t: "scroll" })
      effects.push({ t: "stats" })
      return { state: withIndex, effects }
    }

    case "tool.result": {
      const id = state.callIndex[event.id]
      if (id === undefined) {
        // A result with no recorded call (provider skipped the start frame). Show it rather than
        // losing it silently.
        const { block, state: next } = add(state, {
          kind: "tool",
          callId: event.id,
          name: event.name,
          summary: "",
          ok: event.ok,
          content: event.content,
        })
        effects.push({ t: "block.add", block })
        return { state: next, effects }
      }
      const started = state.callStarted[event.id]
      const durationMs = started === undefined ? undefined : Math.max(0, now - started)
      const blocks = state.blocks.map((b): Block =>
        b.id === id && b.kind === "tool"
          ? { ...b, ok: event.ok, content: event.content, ...(durationMs === undefined ? {} : { durationMs }) }
          : b,
      )
      const updated = blocks.find((b) => b.id === id)
      const next: TuiState = {
        ...state,
        blocks,
        turn: { ...state.turn, toolFails: state.turn.toolFails + (event.ok ? 0 : 1) },
      }
      if (updated) effects.push({ t: "block.replace", block: updated })
      effects.push({ t: "stats" })
      return { state: next, effects }
    }

    case "memory.recall": {
      const hits = event.hits as RecallHit[]
      const text = hits.length === 0 ? `recalled nothing for ${JSON.stringify(event.query)}` : `recalled ${hits.length} note(s) · ${event.tokens} tok`
      const { block, state: next } = add(state, { kind: "memory", text })
      const withCount: TuiState = { ...next, turn: { ...next.turn, memHits: next.turn.memHits + hits.length } }
      effects.push({ t: "block.add", block })
      effects.push({ t: "stats" })
      return { state: withCount, effects }
    }

    case "memory.write": {
      const text = event.rejected
        ? `memory rejected (${event.rejected}): ${event.title}`
        : `memory saved: ${event.title}`
      const { block, state: next } = add(state, { kind: "memory", text })
      const withCount: TuiState = { ...next, turn: { ...next.turn, memWrites: next.turn.memWrites + (event.rejected ? 0 : 1) } }
      effects.push({ t: "block.add", block })
      return { state: withCount, effects }
    }

    case "approval.request": {
      const approval: Approval = { id: event.id, kind: event.kind, summary: "" }
      const next: TuiState = {
        ...state,
        mode: "approval",
        approvals: [...state.approvals, approval],
      }
      effects.push({ t: "approval" })
      effects.push({ t: "mode" })
      return { state: next, effects }
    }

    case "usage": {
      const next: TuiState = {
        ...state,
        turn: {
          ...state.turn,
          in: state.turn.in + event.turnInput,
          out: state.turn.out + event.turnOutput,
        },
        usage: { sessionIn: event.sessionInput, sessionOut: event.sessionOutput },
      }
      effects.push({ t: "stats" })
      return { state: next, effects }
    }

    case "turn.end": {
      const next: TuiState = {
        ...state,
        mode: "idle",
        approvals: [],
        turn: { ...state.turn, endedAt: now },
        pendingSubmit: state.pendingSubmit,
      }
      effects.push({ t: "mode" })
      effects.push({ t: "approval" })
      effects.push({ t: "stats" })
      if (state.pendingSubmit !== null) {
        effects.push({ t: "submit", text: state.pendingSubmit })
        effects.push({ t: "input.clear" })
        return { state: { ...next, pendingSubmit: null }, effects }
      }
      return { state: next, effects }
    }

    case "error": {
      const { block, state: next } = add(state, { kind: "notice", level: "error", text: event.message })
      effects.push({ t: "block.add", block })
      return { state: { ...next, ui: { ...next.ui, lastError: event.message } }, effects }
    }

    default:
      return { state, effects }
  }
}

// ---------------------------------------------------------------------------------------------
// UI-local actions that never come from the agent.
// ---------------------------------------------------------------------------------------------

export type UiAction =
  | { t: "toggleReasoning" }
  | { t: "queueSubmit"; text: string }
  | { t: "popApproval" }

export function applyUi(state: TuiState, action: UiAction): TuiState {
  switch (action.t) {
    case "toggleReasoning":
      return { ...state, ui: { ...state.ui, reasoningVisible: !state.ui.reasoningVisible } }
    case "queueSubmit":
      return { ...state, pendingSubmit: action.text }
    case "popApproval": {
      const approvals = state.approvals.slice(1)
      return { ...state, approvals, mode: approvals.length > 0 ? "approval" : state.mode === "approval" ? "running" : state.mode }
    }
    default:
      return state
  }
}
