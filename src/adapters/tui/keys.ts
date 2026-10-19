import type { Mode } from "./state.ts"

/**
 * Pure key routing.
 *
 * The rule that keeps the input usable: only handle Ctrl/Meta combinations and the approval bar
 * here. Never swallow a printable key, or the text field stops receiving characters.
 */
export interface KeyLike {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}

export type KeyAction =
  | { t: "cancel" }
  | { t: "quit" }
  | { t: "clearInput" }
  | { t: "approve"; allow: boolean }
  | { t: "toggleReasoning" }
  | { t: "toggleTools" }
  | { t: "scroll"; by: number }
  | { t: "scrollBottom" }
  | { t: "redraw" }
  | { t: "none" }

export function routeKey(mode: Mode, key: KeyLike): KeyAction {
  // Approval mode takes priority: the bar is the only thing that can answer it.
  if (mode === "approval") {
    if (key.ctrl && key.name === "c") return { t: "cancel" }
    if (key.name === "a") return { t: "approve", allow: true }
    if (key.name === "d" || key.name === "escape") return { t: "approve", allow: false }
    if (key.name === "enter" || key.name === "return") return { t: "approve", allow: false }
    return { t: "none" }
  }

  if (key.ctrl) {
    switch (key.name) {
      case "c":
        return mode === "running" ? { t: "cancel" } : { t: "clearInput" }
      case "t":
        return { t: "toggleReasoning" }
      case "o":
        return { t: "toggleTools" }
      case "l":
        return { t: "redraw" }
      case "u":
        return { t: "scroll", by: -10 }
      case "d":
        return { t: "scroll", by: 10 }
      default:
        return { t: "none" }
    }
  }

  if (mode === "running" && key.name === "escape") return { t: "cancel" }

  switch (key.name) {
    case "pageup":
      return { t: "scroll", by: -10 }
    case "pagedown":
      return { t: "scroll", by: 10 }
    case "end":
      return { t: "scrollBottom" }
    default:
      return { t: "none" }
  }
}
