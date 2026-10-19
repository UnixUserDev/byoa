/**
 * A unified-diff applier. Pure functions, so the fuzz and failure behaviour is unit-testable.
 *
 * The model writes these patches by hand, so the common failure is a hunk whose line numbers are
 * slightly off. We search a couple of lines either side of the expected position before giving up,
 * which is the same trick `patch(1)` uses.
 */
export interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Patches written on Windows arrive with CRLF; the file may too. Compare without the CR. */
function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line
}

export function parseUnifiedDiff(text: string): { hunks: Hunk[] } | { error: string } {
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  let seenHunk = false

  for (const raw of text.split("\n")) {
    const line = stripCr(raw)
    const header = HUNK_HEADER.exec(line)
    if (header) {
      if (current) hunks.push(current)
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      seenHunk = true
      continue
    }
    if (!current) continue
    // `---`/`+++` are file headers, and they only appear *before* the first hunk. Inside a hunk body
    // they are content: deleting `-- x` renders as `--- x`, and adding `++ x` as `+++ x`. Skipping
    // those silently dropped the change and still reported success.
    if (!seenHunk && (line.startsWith("---") || line.startsWith("+++"))) continue
    if (line.startsWith("\\")) continue // "\ No newline at end of file"
    if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) {
      current.lines.push(line)
    }
  }
  if (current) hunks.push(current)

  if (hunks.length === 0) return { error: "no @@ hunks found in the patch" }
  return { hunks }
}

function findBlock(lines: string[], block: string[], expected: number, fuzz: number): number {
  if (block.length === 0) return Math.max(0, Math.min(expected, lines.length))
  const matches = (start: number): boolean =>
    start >= 0 && start + block.length <= lines.length && block.every((line, index) => lines[start + index] === line)

  if (matches(expected)) return expected
  for (let distance = 1; distance <= fuzz; distance += 1) {
    if (matches(expected - distance)) return expected - distance
    if (matches(expected + distance)) return expected + distance
  }
  return -1
}

export function applyHunks(
  original: string,
  hunks: Hunk[],
  fuzz = 2,
): { ok: true; content: string } | { ok: false; error: string } {
  // The shell on Windows writes CRLF files, and a patch against one used to fail every time with a
  // "does not match the file" message that blamed the patch instead of the line endings. Compare
  // without the CR, then put the file's own ending back on the way out.
  const crlf = original.includes("\r\n")
  const lines = original.split("\n").map(stripCr)
  let offset = 0

  for (const hunk of hunks) {
    const oldLines = hunk.lines
      .filter((line) => line.startsWith(" ") || line.startsWith("-"))
      .map((line) => line.slice(1))
    const newLines = hunk.lines
      .filter((line) => line.startsWith(" ") || line.startsWith("+"))
      .map((line) => line.slice(1))

    // A zero-count hunk means "insert after old line N", and git writes it as `@@ -N,0 +M,K @@`.
    // The -1 that converts a 1-based start to a 0-based index does not apply here.
    const expected = (hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1) + offset
    const index = findBlock(lines, oldLines, expected, fuzz)
    if (index === -1) {
      return {
        ok: false,
        error: `hunk at line ${hunk.oldStart} does not match the file (expected ${oldLines.length} context line(s))`,
      }
    }
    lines.splice(index, oldLines.length, ...newLines)
    offset += newLines.length - oldLines.length
  }

  const joined = lines.join("\n")
  return { ok: true, content: crlf ? joined.replace(/\n/g, "\r\n") : joined }
}

export function applyPatch(
  original: string,
  patchText: string,
  fuzz = 2,
): { ok: true; content: string } | { ok: false; error: string } {
  const parsed = parseUnifiedDiff(patchText)
  if ("error" in parsed) return { ok: false, error: parsed.error }
  return applyHunks(original, parsed.hunks, fuzz)
}
