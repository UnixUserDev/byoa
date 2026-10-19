import type { AgentEvent, AgentHandle } from "../../core/events.ts"
import { applyUi, initialState, reduce, type Effect, type TuiState } from "./state.ts"
import { routeKey } from "./keys.ts"
import { summarizeTool } from "./format.ts"
import { createView, type Kit, type View } from "./render.ts"

/**
 * The composition root for the TUI: one event pump, one view, one input. Nothing here reaches
 * into the agent; it only sends AgentCommands and renders AgentEvents, exactly like the REPL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface AppOptions {
  agent: AgentHandle
  kit: Kit
  renderer: any
  width: number
  height: number
  onSessionChange?: (info: { provider: string; model: string; tier: string }) => void
  onQuit?: () => void
  onExit?: (code: number) => void
}

export interface App {
  root: any
  state(): TuiState
  handleEvent(event: AgentEvent): void
  dispose(): void
}

/** Token-shape args are summarised from the agent's tool.call event, not from a blocked tool. */
function toolSummary(args: unknown): string {
  return summarizeTool("", args)
}

export function createApp(options: AppOptions): App {
  let state = initialState()
  const view: View = createView(options.kit, options.renderer, options.width, options.height)

  /**
   * Coalesce streamed text. `TextRenderable.content` re-renders the node, so calling it per token
   * is wasteful; batching at ~30 fps keeps the stream smooth and the string work bounded.
   */
  const dirty = new Set<number>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let toolsExpanded = false
  const flushText = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    for (const id of dirty) {
      const block = state.blocks.find((candidate) => candidate.id === id)
      if (block && (block.kind === "assistant" || block.kind === "reasoning")) view.setBlockText(id, block.text)
    }
    dirty.clear()
  }
  const scheduleText = (id: number): void => {
    dirty.add(id)
    if (flushTimer === null) {
      flushTimer = setTimeout(flushText, 33)
      if (typeof flushTimer.unref === "function") flushTimer.unref()
    }
  }

  /** Add the user's message to the transcript and hand it to the agent. */
  const sendPrompt = (text: string): void => {
    const block = { kind: "user" as const, id: state.nextId, text }
    const blocks = [...state.blocks, block]
    state = { ...state, blocks: blocks.length > 400 ? blocks.slice(blocks.length - 400) : blocks, nextId: state.nextId + 1 }
    view.addBlock(block)
    view.scrollBottom()
    options.agent.send({ t: "submit", text })
  }

  const applyEffects = (effects: Effect[]): void => {
    for (const effect of effects) {
      switch (effect.t) {
        case "header":
          view.renderHeader(state)
          if (state.session.provider.length > 0 && options.onSessionChange) {
            options.onSessionChange({
              provider: state.session.provider,
              model: state.session.model,
              tier: state.session.tier,
            })
          }
          break
        case "stats":
          view.renderStats(state)
          break
        case "block.add":
          view.addBlock(effect.block)
          break
        case "block.append":
          scheduleText(effect.id)
          break
        case "block.replace":
          flushText()
          view.replaceBlock(effect.block)
          break
        case "block.trim":
          view.trim(effect.keep)
          break
        case "approval":
          flushText()
          view.renderApproval(state)
          view.renderMode(state)
          break
        case "mode":
          view.renderMode(state)
          break
        case "scroll":
          view.scrollBottom()
          break
        case "input.clear":
          view.input.value = ""
          break
        case "submit":
          sendPrompt(effect.text)
          break
        case "quit":
          options.onQuit?.()
          break
      }
    }
  }

  const handleEvent = (event: AgentEvent): void => {
    // Streamed text is coalesced; a tool boundary or the end of a turn must not render ahead of it.
    if (event.t === "turn.end" || event.t === "error") flushText()
    const before = state
    const result = reduce(before, event, Date.now())
    state = result.state

    // The reducer records tool calls without the argument summary (it is UI-only formatting), so
    // fill it in here where the raw args are still available.
    if (event.t === "tool.call") {
      const id = state.callIndex[event.id]
      if (id !== undefined) {
        const summary = toolSummary(event.args)
        state = {
          ...state,
          blocks: state.blocks.map((block) =>
            block.id === id && block.kind === "tool" ? { ...block, summary } : block,
          ),
        }
        const block = state.blocks.find((b) => b.id === id)
        if (block) view.replaceBlock(block)
      }
    }

    applyEffects(result.effects)
    if (state.blocks.length > 0 && result.effects.some((e) => e.t === "block.add")) {
      view.scrollBottom()
    }
  }

  // -------------------------------------------------------------------------------------------
  // Input and keys
  // -------------------------------------------------------------------------------------------

  const submit = (): void => {
    const text = String(view.input.value ?? "").trim()
    if (text.length === 0) return

    if (text === "/exit" || text === "/quit") {
      options.onQuit?.()
      return
    }
    if (text === "/help") {
      view.input.value = ""
      handleEvent({ t: "error", message: "/exit /cancel /tier <lite|normal|large> /model [provider/]model  ·  ^T thinking  ^O tools", fatal: false })
      return
    }
    if (text === "/cancel") {
      view.input.value = ""
      options.agent.send({ t: "cancel" })
      return
    }
    if (text.startsWith("/tier ")) {
      const tier = text.slice(6).trim()
      view.input.value = ""
      if (tier === "lite" || tier === "normal" || tier === "large") {
        options.agent.send({ t: "set.tier", tier })
      } else {
        handleEvent({ t: "error", message: `unknown tier '${tier}' (expected lite, normal, large)`, fatal: false })
      }
      return
    }
    if (text.startsWith("/model ")) {
      const arg = text.slice(7).trim()
      view.input.value = ""
      const slash = arg.indexOf("/")
      const provider = slash > 0 ? arg.slice(0, slash) : state.session.provider
      const model = slash > 0 ? arg.slice(slash + 1) : arg
      options.agent.send({ t: "set.model", provider, model })
      return
    }

    if (state.mode === "running" || state.mode === "approval") {
      state = applyUi(state, { t: "queueSubmit", text })
      view.input.value = ""
      return
    }

    view.input.value = ""
    sendPrompt(text)
  }

  view.input.on(options.kit.InputRenderableEvents.ENTER, submit)

  const onKey = (key: any): void => {
    const action = routeKey(state.mode, key)
    switch (action.t) {
      case "cancel":
        options.agent.send({ t: "cancel" })
        return
      case "clearInput":
        if (String(view.input.value ?? "").length > 0) view.input.value = ""
        else options.onQuit?.()
        return
      case "approve": {
        const approval = state.approvals[0]
        if (approval) {
          options.agent.send({ t: "approve", id: approval.id, allow: action.allow })
          state = applyUi(state, { t: "popApproval" })
          view.renderApproval(state)
          view.renderMode(state)
          view.focusInput()
        }
        return
      }
      case "toggleReasoning":
        state = applyUi(state, { t: "toggleReasoning" })
        view.setReasoningVisible(state.ui.reasoningVisible)
        return
      case "toggleTools":
        toolsExpanded = !toolsExpanded
        view.setToolsExpanded(toolsExpanded)
        return
      case "scroll":
        view.scrollBy(action.by)
        return
      case "scrollBottom":
        view.scrollBottom()
        return
      case "redraw":
        options.renderer.requestRender?.()
        return
      default:
        return
    }
  }

  if (options.renderer.keyInput?.on) options.renderer.keyInput.on("keypress", onKey)

  const onResize = (width: number, height: number): void => {
    view.setSize(width, height)
    view.renderHeader(state)
    view.renderStats(state)
  }
  if (options.renderer.on) options.renderer.on("resize", onResize)

  // 1 Hz ticker: only the stats line changes while a turn runs.
  const ticker = setInterval(() => {
    if (state.mode === "running") view.renderStats(state)
  }, 1000)
  if (typeof ticker.unref === "function") ticker.unref()

  view.renderHeader(state)
  view.renderStats(state)
  view.renderMode(state)
  view.renderApproval(state)
  view.focusInput()

  // Quiet empty state: one dim line, no logo, no centred splash.
  const welcome = {
    kind: "notice" as const,
    id: 0,
    level: "info" as const,
    text: "Ready. Type a request, or /help.",
  }
  state = { ...state, blocks: [welcome] }
  view.addBlock(welcome)

  return {
    root: view.root,
    state: () => state,
    handleEvent,
    dispose: () => {
      flushText()
      if (flushTimer !== null) clearTimeout(flushTimer)
      clearInterval(ticker)
      if (options.renderer.keyInput?.off) options.renderer.keyInput.off("keypress", onKey)
      if (options.renderer.off) options.renderer.off("resize", onResize)
    },
  }
}
