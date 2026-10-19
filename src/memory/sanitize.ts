/**
 * Title hygiene for memory notes.
 *
 * Port of the `sanitize_title` / `unique_path` rules in obsidian-memory/mem.py, so a note
 * written by the TypeScript engine and one written by the Python engine land in the same folder
 * with the same filename and never clobber each other.
 *
 * The title is supplied by the caller (the agent). Nothing is invented here: a title that boils
 * away to nothing, or that cannot be shortened without cutting a word in half, is the caller's
 * problem to fix — we raise rather than paper over it with a guess.
 */
export class TitleError extends Error {}

const BAD_FILENAME = /[\\/:*?"<>|]/g
const MAX_TITLE = 72

export function sanitizeTitle(raw: string, maxlen: number = MAX_TITLE): string {
  let t = raw.replace(BAD_FILENAME, " ")
  t = t.split(/\s+/).filter(Boolean).join(" ")
  t = t.replace(/^[-—\s.]+/, "").trim().replace(/^\.+/, "").trim()
  t = t.replace(/[ .,;:!?—-]+$/, "").trim()
  if (t.length === 0) throw new TitleError("title is empty (nothing but punctuation/whitespace)")
  if (t.length > maxlen) {
    if (!t.slice(0, maxlen).includes(" ")) {
      throw new TitleError(`title's first word is longer than ${maxlen} characters — shorten it`)
    }
    t = t.slice(0, maxlen).replace(/\s+\S*$/, "").replace(/[ .,;:!?—-]+$/, "").trim()
    if (t.length === 0) throw new TitleError("title cannot be shortened without cutting a word in half")
  }
  return t
}

/** Tags are groups, not labels: no spaces, no leading slashes. */
export function sanitizeTag(raw: string): string {
  const t = raw.trim().replace(/^#/, "").replace(/\s+/g, "-").replace(/^\/+|\/+$/g, "")
  return t.length > 0 ? t : "memory"
}

import { existsSync } from "node:fs"
import { join } from "node:path"

/** The path a new note will occupy, with " 2", " 3" suffixes for duplicates. */
export function uniqueTitlePath(memdir: string, title: string): string {
  const base = join(memdir, `${title}.md`)
  if (!existsSync(base)) return base
  let i = 2
  for (;;) {
    const cand = join(memdir, `${title} ${i}.md`)
    if (!existsSync(cand)) return cand
    i += 1
  }
}
