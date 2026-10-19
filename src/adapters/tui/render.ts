import type { Block, TuiState } from "./state.ts"
import { glyph, theme } from "./theme.ts"
import { splitStatus, truncate } from "./format.ts"

/**
 * The OpenTUI module is injected, not imported. That keeps this file out of the smoke test's
 * runtime path (no native FFI without a terminal) and means `run.ts` is the only module that
 * actually loads the optional dependency.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Kit {
  BoxRenderable: new (ctx: any, options: any) => any
  TextRenderable: new (ctx: any, options: any) => any
  InputRenderable: new (ctx: any, options: any) => any
  ScrollBoxRenderable: new (ctx: any, options: any) => any
  InputRenderableEvents: { ENTER: string; INPUT: string }
}

export interface View {
  root: any
  input: any
  addBlock(block: Block): void
  setBlockText(id: number, text: string): void
  replaceBlock(block: Block): void
  trim(keep: number): void
  renderHeader(state: TuiState): void
  renderStats(state: TuiState): void
  renderApproval(state: TuiState): void
  renderMode(state: TuiState): void
  setReasoningVisible(visible: boolean): void
  setToolsExpanded(expanded: boolean): void
  scrollBy(delta: number): void
  scrollBottom(): void
  focusInput(): void
  setSize(width: number, height: number): void
}

const blockColors: Record<Block["kind"], string> = {
  user: theme.accent,
  assistant: theme.text,
  reasoning: theme.dim,
  tool: theme.text,
  memory: theme.dim,
  notice: theme.text,
}

export function createView(kit: Kit, ctx: any, width: number, height: number): View {
  const root = new kit.BoxRenderable(ctx, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  })

  const headerRow = new kit.BoxRenderable(ctx, {
    flexDirection: "row",
    justifyContent: "space-between",
    height: 1,
    paddingX: 1,
  })
  const headerLeft = new kit.TextRenderable(ctx, { content: "byoa", fg: theme.text })
  const headerRight = new kit.TextRenderable(ctx, { content: "", fg: theme.dim })
  headerRow.add(headerLeft)
  headerRow.add(headerRight)

  const rule = new kit.BoxRenderable(ctx, {
    height: 1,
    border: ["bottom"],
    borderColor: theme.faint,
  })

  const transcript = new kit.ScrollBoxRenderable(ctx, {
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    scrollY: true,
    scrollX: false,
    viewportCulling: true,
    verticalScrollbarOptions: { visible: true },
  })
  const content = new kit.BoxRenderable(ctx, { flexDirection: "column", paddingX: 1 })
  transcript.add(content)

  const approvalRow = new kit.BoxRenderable(ctx, { height: 0, paddingX: 1 })
  const approvalText = new kit.TextRenderable(ctx, { content: "", fg: theme.warn })
  approvalRow.add(approvalText)

  const inputRow = new kit.BoxRenderable(ctx, {
    flexDirection: "row",
    // Two rows: one for the top border, one for the input. A bordered box with height 1 has no
    // content row and its child paints into the next row (the status line).
    height: 2,
    paddingX: 1,
    border: ["top"],
    borderColor: theme.faint,
  })
  const inputMarker = new kit.TextRenderable(ctx, { content: `${glyph.user} `, fg: theme.accent })
  const input = new kit.InputRenderable(ctx, {
    flexGrow: 1,
    // Leading space so the block cursor does not sit on top of the first placeholder character.
    placeholder: " ask byoa…",
    value: "",
  })
  inputRow.add(inputMarker)
  inputRow.add(input)

  const statusRow = new kit.BoxRenderable(ctx, {
    flexDirection: "row",
    justifyContent: "space-between",
    height: 1,
    paddingX: 1,
  })
  const statusLeft = new kit.TextRenderable(ctx, { content: "ready", fg: theme.dim })
  const statusRight = new kit.TextRenderable(ctx, { content: "", fg: theme.faint })
  statusRow.add(statusLeft)
  statusRow.add(statusRight)

  const keybar = new kit.TextRenderable(ctx, { content: "", fg: theme.faint, height: 1, paddingX: 1 })

  root.add(headerRow)
  root.add(rule)
  root.add(transcript)
  root.add(approvalRow)
  root.add(inputRow)
  root.add(statusRow)
  root.add(keybar)

  let currentWidth = width
  let currentHeight = height

  /** block id -> its renderable. */
  const rendered = new Map<number, any>()
  /** block id -> the block itself, so a toggle can rebuild its text without the state. */
  const blocksById = new Map<number, Block>()
  /** ids of reasoning blocks, so Ctrl+T can toggle them without walking the state. */
  const reasoningIds = new Set<number>()
  /** block id -> accumulated text. */
  const buffers = new Map<number, string>()
  let toolsExpanded = false

  const textOf = (block: Block): string => {
    switch (block.kind) {
      case "user":
        return `${glyph.user} ${block.text}`
      case "assistant":
        return block.text
      case "reasoning":
        return block.text
      case "memory":
        return `${glyph.memory} ${block.text}`
      case "notice":
        return block.text
      case "tool": {
        const mark = block.ok === null ? glyph.pending : block.ok ? glyph.ok : glyph.fail
        const duration = block.durationMs === undefined ? "" : ` · ${Math.round(block.durationMs)}ms`
        const summary = block.summary.length > 0 ? ` ${block.summary}` : ""
        const line = `${glyph.tool} ${block.name}${summary} ${mark}${duration}`
        if (!toolsExpanded || block.content === undefined || block.content.trim().length === 0) return line
        return `${line}\n${truncate(block.content.trimEnd(), Math.max(40, currentWidth - 4))}`
      }
      default:
        return ""
    }
  }

  const colorOf = (block: Block): string => {
    if (block.kind === "tool" && block.ok === false) return theme.error
    if (block.kind === "notice" && block.level === "error") return theme.error
    if (block.kind === "notice" && block.level === "warn") return theme.warn
    return blockColors[block.kind]
  }

  const addBlock = (block: Block): void => {
    if (rendered.has(block.id)) return
    blocksById.set(block.id, block)
    const text = textOf(block)
    buffers.set(block.id, text)
    const node = new kit.TextRenderable(ctx, {
      content: text,
      fg: colorOf(block),
      wrapMode: "word",
      ...(block.kind === "reasoning" ? { visible: false } : {}),
    })
    rendered.set(block.id, node)
    if (block.kind === "reasoning") reasoningIds.add(block.id)
    content.add(node)
  }

  /**
   * Replace the whole text of a block.
   *
   * `TextRenderable.add(string)` looks like an append but the string is not treated as text
   * content by this version, so streamed deltas after the first silently vanished. Setting
   * `content` is the reliable path; the app coalesces deltas so this is not called per token.
   */
  const setBlockText = (id: number, text: string): void => {
    const node = rendered.get(id)
    if (!node) return
    buffers.set(id, text)
    node.content = text
  }

  const replaceBlock = (block: Block): void => {
    blocksById.set(block.id, block)
    const node = rendered.get(block.id)
    if (!node) {
      addBlock(block)
      return
    }
    const text = textOf(block)
    buffers.set(block.id, text)
    node.content = text
    node.fg = colorOf(block)
  }

  const trim = (keep: number): void => {
    const ids = [...rendered.keys()]
    const excess = ids.length - keep
    if (excess <= 0) return
    for (const id of ids.slice(0, excess)) {
      const node = rendered.get(id)
      if (node) content.remove(node)
      rendered.delete(id)
      blocksById.delete(id)
      reasoningIds.delete(id)
      buffers.delete(id)
    }
  }

  const renderHeader = (state: TuiState): void => {
    const title = state.session.title.length > 0 ? state.session.title : "untitled"
    headerLeft.content = `byoa · ${truncate(title, Math.max(10, Math.floor(currentWidth / 2)))}`
    headerRight.content = truncate(state.session.cwd, Math.max(10, Math.floor(currentWidth / 3)))
  }

  const renderStats = (state: TuiState): void => {
    const elapsed =
      state.turn.startedAt === null
        ? 0
        : (state.turn.endedAt ?? Date.now()) - state.turn.startedAt
    const { left, right } = splitStatus({
      turnIn: state.turn.in,
      turnOut: state.turn.out,
      elapsedMs: Math.max(0, elapsed),
      tools: state.turn.tools,
      toolFails: state.turn.toolFails,
      memHits: state.turn.memHits,
      model: state.session.model,
      tier: state.session.tier,
      sandbox: state.sandbox.badge,
      width: currentWidth,
    })
    statusLeft.content = left
    statusRight.content = right
  }

  const renderApproval = (state: TuiState): void => {
    const approval = state.approvals[0]
    if (!approval) {
      approvalRow.height = 0
      approvalText.content = ""
      return
    }
    approvalRow.height = 1
    const more = state.approvals.length > 1 ? ` (+${state.approvals.length - 1})` : ""
    approvalText.content = `! ${approval.kind} approval needed${more}   a allow · d deny`
  }

  const renderMode = (state: TuiState): void => {
    if (state.mode === "approval") {
      input.visible = false
      inputMarker.visible = false
    } else {
      input.visible = true
      inputMarker.visible = true
    }
  }

  const setSize = (nextWidth: number, nextHeight: number): void => {
    currentWidth = nextWidth
    currentHeight = nextHeight
    keybar.content =
      nextHeight < 16 || nextWidth < 70
        ? ""
        : "⏎ send · ^C cancel · ^T thinking · ^O tools · /help · /exit"
  }

  setSize(width, height)

  return {
    root,
    input,
    addBlock,
    setBlockText,
    replaceBlock,
    trim,
    renderHeader,
    renderStats,
    renderApproval,
    renderMode,
    setReasoningVisible: (visible: boolean) => {
      for (const id of reasoningIds) {
        const node = rendered.get(id)
        if (node) node.visible = visible
      }
    },
    setToolsExpanded: (expanded: boolean) => {
      toolsExpanded = expanded
      for (const [id, block] of blocksById) {
        if (block.kind !== "tool") continue
        const node = rendered.get(id)
        if (node) node.content = textOf(block)
      }
    },
    scrollBy: (delta: number) => {
      if (typeof transcript.scrollBy === "function") transcript.scrollBy({ x: 0, y: delta })
    },
    scrollBottom: () => {
      if (typeof transcript.scrollTo === "function") transcript.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER })
    },
    focusInput: () => {
      if (typeof input.focus === "function") input.focus()
    },
    setSize,
  }
}
