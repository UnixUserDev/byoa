/**
 * One accent, a few greys, no palette zoo.
 *
 * The brief was "calm and nice, not cluttered, but with real statistics". That means restraint:
 * colour carries meaning only where meaning matters (accent for what you typed, red for failure,
 * amber for a degraded sandbox), and everything else is a step on the grey ramp.
 */
export const theme = {
  accent: "#8ab4f8",
  accentDim: "#5f7fa8",
  text: "#d8dee9",
  dim: "#7b8394",
  faint: "#565d6b",
  error: "#e06c75",
  warn: "#d9a441",
  ok: "#7fb37a",
  bg: "transparent",
} as const

/** Glyphs are plain Unicode; no nerd-font codepoints that turn into tofu. */
export const glyph = {
  user: "›",
  tool: "·",
  ok: "✓",
  fail: "✗",
  memory: "◇",
  rule: "─",
  pending: "…",
} as const

/** Layout switches, in columns. */
export const breakpoints = {
  compact: 90,
  noKeybar: 70,
  tiny: 50,
} as const
