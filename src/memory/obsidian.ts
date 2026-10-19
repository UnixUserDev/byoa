import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { MemoryStore, MemoryNote, RecallHit, RecallInput, RememberInput } from "./types.ts"
import { estimateTokens } from "../core/tokens.ts"
import { redact } from "../config/secrets.ts"
import { sanitizeTitle, sanitizeTag, uniqueTitlePath, TitleError } from "./sanitize.ts"

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS mem USING fts5(
    path    UNINDEXED,
    title,
    tags,
    body,
    created UNINDEXED,
    tokenize = 'porter unicode61'
);
`

interface ParsedNote {
  tags: string[]
  created: string
  source: string
  body: string
}

function parseNote(text: string): ParsedNote {
  const tags: string[] = []
  let created = ""
  let source = "agent"
  let body = text
  const lines = text.replace(/^\s+/, "").split("\n")
  const firstLine = lines[0]
  if (firstLine !== undefined && firstLine.trim() === "---") {
    const fm: string[] = []
    let i = 1
    while (i < lines.length) {
      const current = lines[i]
      if (current === undefined || current.trim() === "---") break
      fm.push(current)
      i += 1
    }
    body = lines.slice(i + 1).join("\n").trim()
    let inTags = false
    for (const ln of fm) {
      const s = ln.trim()
      if (s.startsWith("tags:")) {
        inTags = true
        const rest = s.slice("tags:".length).trim()
        if (rest.startsWith("[")) {
          for (const t of rest.replace(/^\[|\]$/g, "").split(",")) {
            const clean = t.trim().replace(/^['"#]+|['"]+$/g, "")
            if (clean) tags.push(clean)
          }
        } else if (rest.length > 0) {
          tags.push(rest.replace(/^['"#]+|['"]+$/g, ""))
        }
      } else if (inTags && s.startsWith("- ")) {
        const t = s.slice(2).trim().replace(/^['"#]+|['"]+$/g, "")
        if (t) tags.push(t)
      } else if (s.includes(":") && !s.startsWith("- ")) {
        inTags = false
        const parts = s.split(":", 2)
        const k = (parts[0] ?? "").trim()
        const v = (parts[1] ?? "").trim()
        if (k === "created") created = v
        if (k === "source") source = v
      }
    }
  }
  return { tags, created, source, body }
}

function iterNotes(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue
      const full = join(d, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else if (name.endsWith(".md")) out.push(full)
    }
  }
  walk(dir)
  return out.sort()
}

function ftsQuery(q: string): string | null {
  const terms = (q.match(/\w+/gu) ?? []).filter(Boolean)
  if (terms.length === 0) return null
  return terms.map((t) => `"${t}"`).join(" OR ")
}

function defaultVault(): string {
  return process.env.BYOA_VAULT ?? process.env.MEM_VAULT ?? join(homedir(), "Documents", "Obsidian Vault")
}

/**
 * An Obsidian-backed store.
 *
 * `namespace` scopes the store to a subfolder of `<vault>/memory`. byoa uses "byoa" so it can only
 * read and write its own notes, while a store with an empty namespace (the default for a generic
 * reader) sees everything. The on-disk layout stays one shared index per vault, so a manual reindex
 * with mem.py still reconciles every note.
 */
export class ObsidianMemoryStore implements MemoryStore {
  readonly #vault: string
  readonly #namespace: string
  readonly #memdir: string
  readonly #nsdir: string
  readonly #db: DatabaseSync
  readonly #source: string

  constructor(vault?: string, namespace: string = "") {
    this.#vault = vault ?? defaultVault()
    this.#namespace = namespace
    this.#memdir = join(this.#vault, "memory")
    this.#nsdir = namespace.length > 0 ? join(this.#memdir, namespace) : this.#memdir
    this.#source = namespace.length > 0 ? namespace : "agent"
    mkdirSync(this.#nsdir, { recursive: true })
    this.#db = new DatabaseSync(join(this.#memdir, ".index.db"))
    this.#db.exec("PRAGMA busy_timeout = 5000")
    this.#db.exec(SCHEMA)
    this.#syncIndex()
  }

  get vault(): string {
    return this.#vault
  }

  get namespace(): string {
    return this.#namespace
  }

  #inNamespace(path: string): boolean {
    if (this.#namespace.length === 0) return true
    const prefix = this.#nsdir + "/"
    return path === this.#nsdir || path.startsWith(prefix)
  }

  #syncIndex(): void {
    const onDisk = new Set(iterNotes(this.#nsdir))
    const indexed = new Set<string>()
    for (const row of this.#db.prepare("SELECT path FROM mem").all() as Array<{ path: string }>) {
      if (this.#inNamespace(row.path)) indexed.add(row.path)
    }
    for (const stale of indexed) {
      if (!onDisk.has(stale)) this.#db.prepare("DELETE FROM mem WHERE path = ?").run(stale)
    }
    for (const fresh of onDisk) {
      if (!indexed.has(fresh)) this.#indexFile(fresh)
    }
  }

  #indexFile(path: string): void {
    const text = readFileSync(path, "utf8")
    const { tags, created, body } = parseNote(text)
    const title = (path.split("/").pop() ?? "").replace(/\.md$/, "")
    this.#db.prepare("DELETE FROM mem WHERE path = ?").run(path)
    this.#db.prepare("INSERT INTO mem(path, title, tags, body, created) VALUES (?,?,?,?,?)").run(
      path,
      title,
      ` ${tags.join(" ")} `,
      body,
      created,
    )
  }

  async recall(input: RecallInput): Promise<RecallHit[]> {
    this.#syncIndex()
    const fq = ftsQuery(input.query)
    if (!fq) return []
    const wantTag = input.tag ? ` ${input.tag.replace(/^#/, "")} ` : null
    const over = wantTag ? input.limit * 5 : input.limit
    const rows = this.#db
      .prepare(
        "SELECT path, title, tags, created, snippet(mem, 3, '<<', '>>', ' … ', 12) AS snip, bm25(mem) AS score FROM mem WHERE mem MATCH ? ORDER BY score LIMIT ?",
      )
      .all(fq, over) as Array<{
      path: string
      title: string
      tags: string
      created: string
      snip: string
      score: number
    }>

    const inNs = rows.filter((r) => this.#inNamespace(r.path))
    const filtered = wantTag
      ? inNs.filter((r) => r.tags.includes(wantTag)).slice(0, input.limit)
      : inNs.slice(0, input.limit)

    const excluded = new Set(input.excludePaths ?? [])
    const hits: RecallHit[] = []
    let budget = input.budgetTokens
    for (const r of filtered) {
      if (excluded.has(r.path)) continue
      const tag = r.tags.trim().split(/\s+/).filter(Boolean).join(" ") || "memory"
      const snippet = (r.snip ?? "").trim() || "(match in title/tags)"
      const tokens = estimateTokens(`${r.title}\n${snippet}`)
      if (tokens > budget && hits.length > 0) break
      budget -= tokens
      hits.push({
        path: r.path,
        title: r.title,
        tag,
        created: r.created,
        snippet,
        score: r.score,
        tokens,
      })
      if (hits.length >= input.limit) break
    }
    return hits
  }

  async remember(input: RememberInput): Promise<{ path: string; rejected?: string }> {
    const text = input.text.trim()
    if (text.length === 0) return { path: "", rejected: "text is empty" }

    if (redact(text) !== text) return { path: "", rejected: "secret detected" }
    if (redact(input.title) !== input.title) return { path: "", rejected: "secret detected" }

    let title: string
    try {
      title = sanitizeTitle(input.title)
    } catch (error: unknown) {
      return { path: "", rejected: error instanceof Error ? error.message : String(error) }
    }

    const tag = sanitizeTag(input.tag)
    const tags = [tag]

    const now = new Date()
    const created = now.toISOString().slice(0, 19)
    mkdirSync(this.#nsdir, { recursive: true })
    const path = uniqueTitlePath(this.#nsdir, title)

    const body =
      "---\n" +
      "tags:\n" +
      tags.map((t) => `  - ${t}\n`).join("") +
      `created: ${created}\n` +
      `source: ${input.source === "agent" ? this.#source : input.source}\n` +
      "---\n\n" +
      text +
      "\n\n[[Inbox]]\n"

    writeFileSync(path, body, "utf8")
    this.#indexFile(path)
    return { path }
  }

  async list(options?: { tag?: string }): Promise<MemoryNote[]> {
    this.#syncIndex()
    const rows = this.#db.prepare("SELECT path, title, tags, created, body FROM mem ORDER BY created DESC").all() as Array<{
      path: string
      title: string
      tags: string
      created: string
      body: string
    }>
    const want = options?.tag ? ` ${options.tag.replace(/^#/, "")} ` : null
    const out: MemoryNote[] = []
    for (const r of rows) {
      if (!this.#inNamespace(r.path)) continue
      if (want && !r.tags.includes(want)) continue
      const note: MemoryNote = {
        path: r.path,
        title: r.title,
        tags: r.tags.trim().split(/\s+/).filter(Boolean),
        created: r.created,
        source: this.#source,
        body: r.body,
      }
      try {
        const parsed = parseNote(readFileSync(r.path, "utf8"))
        note.source = parsed.source || this.#source
      } catch {
        // leave default
      }
      out.push(note)
    }
    return out
  }

  async forget(match: string): Promise<number> {
    this.#syncIndex()
    const targets = iterNotes(this.#nsdir).filter((p) => {
      const stem = (p.split("/").pop() ?? "").replace(/\.md$/, "")
      return stem.toLowerCase().includes(match.toLowerCase())
    })
    let count = 0
    for (const p of targets) {
      this.#db.prepare("DELETE FROM mem WHERE path = ?").run(p)
      try {
        unlinkSync(p)
        count += 1
      } catch {
        // already gone
      }
    }
    return count
  }

  async reindex(): Promise<{ count: number }> {
    const notes = iterNotes(this.#nsdir)
    for (const p of notes) this.#indexFile(p)
    return { count: notes.length }
  }

  async stats(): Promise<{ count: number; byTag: Record<string, number> }> {
    this.#syncIndex()
    const rows = this.#db.prepare("SELECT path, tags FROM mem").all() as Array<{ path: string; tags: string }>
    const byTag: Record<string, number> = {}
    let count = 0
    for (const r of rows) {
      if (!this.#inNamespace(r.path)) continue
      count += 1
      for (const t of r.tags.trim().split(/\s+/).filter(Boolean)) byTag[t] = (byTag[t] ?? 0) + 1
    }
    return { count, byTag }
  }

  close(): void {
    try {
      this.#db.close()
    } catch {
      // already closed
    }
  }
}

export function defaultVaultPath(): string {
  return process.env.BYOA_VAULT ?? join(homedir(), "Documents", "Obsidian Vault")
}
