import type { ToolCallPart } from "./types.ts"

/**
 * Tool-call argument streams are where providers disagree most.
 *
 * OpenAI sends `tool_calls[i].function.arguments` as a string that must be concatenated, often
 * split mid-token, and sometimes arriving after `finish_reason`. Anthropic sends
 * `input_json_delta.partial_json` fragments. Local servers frequently emit the whole object in one
 * shot, omit the `id`, or forget to close a bracket. One accumulator, one repair path, tested once.
 */
export interface ToolCallDraft {
  index: number
  id: string
  name: string
  argsText: string
}

/** Close unterminated strings and unbalanced brackets. Best effort, never throws. */
export function repairJson(text: string): string {
  let inString = false
  let escaped = false
  const stack: string[] = []

  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === "{") stack.push("}")
    else if (character === "[") stack.push("]")
    else if (character === "}" || character === "]") stack.pop()
  }

  let repaired = text
  if (inString) repaired += '"'
  // A trailing comma is the other common truncation artefact.
  repaired = repaired.replace(/,\s*$/, "")
  while (stack.length > 0) repaired += stack.pop()
  return repaired
}

export function parseToolArgs(raw: string): unknown {
  const text = raw.trim()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    // fall through to repair
  }
  try {
    return JSON.parse(repairJson(text))
  } catch {
    return { __unparsed: raw }
  }
}

export class ToolCallAccumulator {
  #drafts = new Map<number, ToolCallDraft>()

  #ensure(index: number): ToolCallDraft {
    const existing = this.#drafts.get(index)
    if (existing) return existing
    const draft: ToolCallDraft = { index, id: "", name: "", argsText: "" }
    this.#drafts.set(index, draft)
    return draft
  }

  /** Idempotent: a repeated start must not wipe arguments that already arrived. */
  start(index: number, id: string, name: string): ToolCallDraft {
    const draft = this.#ensure(index)
    if (id.length > 0) draft.id = id
    if (name.length > 0) draft.name = name
    return draft
  }

  args(index: number, fragment: string): void {
    this.#ensure(index).argsText += fragment
  }

  setArgs(index: number, args: unknown): void {
    this.#ensure(index).argsText = JSON.stringify(args ?? {})
  }

  get size(): number {
    return this.#drafts.size
  }

  drafts(): ToolCallDraft[] {
    return [...this.#drafts.values()].sort((left, right) => left.index - right.index)
  }

  finish(): ToolCallPart[] {
    return this.drafts()
      .filter((draft) => draft.name.length > 0)
      .map((draft) => ({
        type: "tool-call" as const,
        id: draft.id.length > 0 ? draft.id : `call_${draft.index}`,
        name: draft.name,
        args: parseToolArgs(draft.argsText),
      }))
  }
}
