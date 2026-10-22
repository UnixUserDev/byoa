import { breakpoints, glyph, radar } from "./theme.ts"

/**
 * The radar frame for a tick counter. Negative and nonsense values still produce a glyph: this runs
 * inside a render loop, and an empty string would make the line jitter by a cell.
 */
export function radarFrame(tick: number): string {
  if (!Number.isFinite(tick)) return radar[0] as string
  const index = ((Math.trunc(tick) % radar.length) + radar.length) % radar.length
  return radar[index] as string
}

/** 1234 -> "1.2k", 1234567 -> "1.2M". Small numbers stay exact. */
export function compactCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0"
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) {
    const scaled = value / 1000
    return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}k`
  }
  const scaled = value / 1_000_000
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}M`
}

/** 820 -> "0.8s", 12_400 -> "12s", 95_000 -> "1m35s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s"
  const seconds = ms / 1000
  if (seconds < 1) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.floor(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds - minutes * 60)
  return `${minutes}m${rest.toString().padStart(2, "0")}s`
}

/**
 * Tokens per second, wall-clock. Returns "—" below half a second or with no output: at that
 * scale the timing is mostly noise and printing "1333 tok/s" for the fake provider is a lie.
 */
export function formatTps(output: number, elapsedMs: number): string {
  if (output <= 0 || elapsedMs < 500) return "—"
  const tps = output / (elapsedMs / 1000)
  return tps >= 100 ? `${Math.round(tps)} tok/s` : `${tps.toFixed(1)} tok/s`
}

export function sandboxBadge(applied: boolean, degraded: boolean): string {
  if (!applied && !degraded) return "sandbox off"
  if (degraded) return "sandbox degraded"
  return "sandbox"
}

/** Truncate from the right, with an ellipsis, never splitting a surrogate pair. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return ""
  const chars = [...text]
  if (chars.length <= max) return text
  if (max <= 1) return "…"
  return `${chars.slice(0, max - 1).join("")}…`
}

/** Keep the tail of a path, so `/home/x/projects/byoa` becomes `…/projects/byoa` when narrow. */
export function tailPath(path: string, max: number): string {
  if (path.length <= max) return path
  const parts = path.split("/")
  let out = ""
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const candidate = out.length === 0 ? (parts[i] as string) : `${parts[i]}/${out}`
    if (candidate.length + 2 > max) break
    out = candidate
  }
  return out.length === 0 ? truncate(path, max) : `…/${truncate(out, max - 2)}`
}

/** One-line tool summary: the argument that actually identifies the call. */
export function summarizeTool(name: string, args: unknown): string {
  if (args === null || typeof args !== "object") return ""
  const record = args as Record<string, unknown>
  const pick = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === "string" ? value : undefined
  }
  const path = pick("path")
  if (path) return path
  const command = pick("command")
  if (command) return command.replace(/\s+/g, " ").trim()
  const query = pick("query")
  if (query) return `"${query}"`
  const title = pick("title")
  if (title) return title
  const first = Object.values(record).find((value) => typeof value === "string")
  return typeof first === "string" ? first.replace(/\s+/g, " ").trim() : ""
}

/** Flatten an approval detail into one safe line. No raw JSON, no newlines, no base64. */
export function summarizeApproval(detail: unknown): string {
  const raw = (() => {
    if (typeof detail === "string") return detail
    try {
      return JSON.stringify(detail)
    } catch {
      return String(detail)
    }
  })()
  const flat = raw.replace(/\s+/g, " ").trim()
  if (/^[A-Za-z0-9+/=]{80,}$/.test(flat)) return "[binary payload elided]"
  return truncate(flat, 160)
}

export interface StatusInput {
  turnIn: number
  turnOut: number
  elapsedMs: number
  tools: number
  toolFails: number
  memHits: number
  model: string
  tier: string
  sandbox: string
  width: number
}

/** The stats line. Zero-value segments are omitted rather than printed as noise. */
export function statusLine(input: StatusInput): { left: string; right: string } {
  const parts: string[] = []
  if (input.turnIn > 0 || input.turnOut > 0) {
    parts.push(`${compactCount(input.turnIn)} in`)
    parts.push(`${compactCount(input.turnOut)} out`)
  }
  if (input.turnOut > 0) parts.push(formatTps(input.turnOut, input.elapsedMs))
  if (input.elapsedMs >= 500) parts.push(formatDuration(input.elapsedMs))
  if (input.tools > 0) {
    parts.push(
      input.width >= breakpoints.compact && input.toolFails > 0
        ? `${input.tools} tools · ${input.toolFails} failed`
        : `${input.tools} tools`,
    )
  }
  if (input.memHits > 0) parts.push(`${input.memHits} mem`)
  const left = parts.length > 0 ? parts.join(" · ") : "ready"

  const model = input.width >= breakpoints.compact ? input.model : (input.model.split("/").pop() ?? input.model)
  const right = [model, input.tier, input.sandbox].filter((part) => part.length > 0).join(" · ")
  return { left, right }
}

/** Split the status line into its two ends, given the available width. */
export function splitStatus(input: StatusInput): { left: string; right: string } {
  const rendered = statusLine(input)
  const room = Math.max(0, input.width - 2)
  const right = truncate(rendered.right, Math.floor(room * 0.55))
  const left = truncate(rendered.left, Math.max(0, room - right.length - 3))
  return { left, right }
}

export function keybar(width: number, height: number): string {
  if (height < 16 || width < breakpoints.noKeybar) return ""
  const parts = ["⏎ send", "^C cancel", "^T thinking", "^O tools", "/help", "/exit"]
  if (width < breakpoints.compact) return parts.slice(0, 4).join(" · ")
  return parts.join(" · ")
}

export { glyph }
