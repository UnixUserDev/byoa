import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { MemoryStore, MemoryNote, RecallHit, RecallInput, RememberInput } from "./types.ts"
import { estimateTokens } from "../core/tokens.ts"
import { redact } from "../config/secrets.ts"
import { sanitizeTitle, sanitizeTag, TitleError } from "./sanitize.ts"

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

function ftsQuery(q: string): string | null {
  const terms = (q.match(/\w+/gu) ?? []).filter(Boolean)
  if (terms.length === 0) return null
  return terms.map((t) => `"${t}"`).join(" OR ")
}

function uniqueTitle(db: DatabaseSync, title: string): string {
  const existing = new Set(
    (db.prepare("SELECT title FROM mem").all() as Array<{ title: string }>).map((r) => r.title),
  )
  if (!existing.has(title)) return title
  let i = 2
  for (;;) {
    const cand = `${title} ${i}`
    if (!existing.has(cand)) return cand
    i += 1
  }
}

export class SqliteMemoryStore implements MemoryStore {
  readonly #db: DatabaseSync
  readonly #namespace: string

  #inNamespace(path: string): boolean {
    if (this.#namespace.length === 0) return true
    return path.startsWith(`${this.#namespace}/`) || path.startsWith(`sqlite:${this.#namespace}/`)
  }

  #prefix(title: string): string {
    return this.#namespace.length > 0 ? `${this.#namespace}/${title}` : title
  }

  constructor(path?: string, namespace: string = "") {
    const dbPath = path && path.length > 0 ? path : join(homedir(), ".local", "share", "byoa", "memory.db")
    mkdirSync(dirname(dbPath), { recursive: true })
    this.#db = new DatabaseSync(dbPath)
    this.#db.exec(SCHEMA)
    this.#namespace = namespace
  }

  async recall(input: RecallInput): Promise<RecallHit[]> {
    const fq = ftsQuery(input.query)
    if (!fq) return []
    const wantTag = input.tag ? ` ${input.tag.replace(/^#/, "")} ` : null
    const over = wantTag ? input.limit * 5 : input.limit
    const rows = this.#db
      .prepare(
        "SELECT path, title, tags, created, snippet(mem, 3, '<<', '>>', ' … ', 12) AS snip, bm25(mem) AS score FROM mem WHERE mem MATCH ? ORDER BY score LIMIT ?",
      )
      .all(fq, over) as Array<{ path: string; title: string; tags: string; created: string; snip: string; score: number }>

    const filtered = (wantTag ? rows.filter((r) => r.tags.includes(wantTag)) : rows)
      .filter((r) => this.#inNamespace(r.path))
      .slice(0, input.limit)
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
      hits.push({ path: r.path, title: r.title, tag, created: r.created, snippet, score: r.score, tokens })
      if (hits.length >= input.limit) break
    }
    return hits
  }

  async remember(input: RememberInput): Promise<{ path: string; rejected?: string }> {
    const text = input.text.trim()
    if (text.length === 0) return { path: "", rejected: "text is empty" }
    if (redact(text) !== text) return { path: "", rejected: "text looks like it contains credentials" }
    if (redact(input.title) !== input.title) return { path: "", rejected: "title looks like it contains credentials" }

    let title: string
    try {
      title = sanitizeTitle(input.title)
    } catch (error: unknown) {
      return { path: "", rejected: error instanceof Error ? error.message : String(error) }
    }
    title = uniqueTitle(this.#db, title)
    const tag = sanitizeTag(input.tag)
    const created = new Date().toISOString().slice(0, 19)
    const path = `sqlite:${this.#prefix(title)}`
    this.#db.prepare("DELETE FROM mem WHERE path = ?").run(path)
    this.#db.prepare("INSERT INTO mem(path, title, tags, body, created) VALUES (?,?,?,?,?)").run(
      path,
      title,
      ` ${tag} `,
      text,
      created,
    )
    return { path }
  }

  async list(options?: { tag?: string }): Promise<MemoryNote[]> {
    const want = options?.tag ? ` ${options.tag.replace(/^#/, "")} ` : null
    const rows = this.#db.prepare("SELECT path, title, tags, created, body FROM mem ORDER BY created DESC").all() as Array<{
      path: string
      title: string
      tags: string
      created: string
      body: string
    }>
    const out: MemoryNote[] = []
    for (const r of rows) {
      if (!this.#inNamespace(r.path)) continue
      if (want && !r.tags.includes(want)) continue
      out.push({
        path: r.path,
        title: r.title,
        tags: r.tags.trim().split(/\s+/).filter(Boolean),
        created: r.created,
        source: "agent",
        body: r.body,
      })
    }
    return out
  }

  async forget(match: string): Promise<number> {
    const rows = this.#db.prepare("SELECT path, title FROM mem").all() as Array<{ path: string; title: string }>
    const targets = rows.filter((r) => this.#inNamespace(r.path) && r.title.toLowerCase().includes(match.toLowerCase()))
    for (const t of targets) this.#db.prepare("DELETE FROM mem WHERE path = ?").run(t.path)
    return targets.length
  }

  async reindex(): Promise<{ count: number }> {
    // Nothing to reconcile: the FTS table is the store.
    const n = (this.#db.prepare("SELECT COUNT(*) AS n FROM mem").get() as { n: number }).n
    return { count: n }
  }

  async stats(): Promise<{ count: number; byTag: Record<string, number> }> {
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
