import type { DatabaseSync } from "node:sqlite"
import type { ProviderMessage } from "../providers/types.ts"
import type { NetMode, SandboxPolicy } from "../sandbox/policy.ts"
import { clonePolicy, DEFAULT_POLICY, NET_MODES, validatePolicy } from "../sandbox/policy.ts"
import type { TierId } from "../prompts/tiers.ts"
import type { AgentPersistence } from "../core/agent.ts"
import { newId } from "../core/ids.ts"

export interface SessionRecord {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  provider: string
  model: string
  tier: TierId
  cwd: string
  policy: SandboxPolicy
  tokensIn: number
  tokensOut: number
}

export interface StoredMessage {
  seq: number
  role: string
  message: ProviderMessage
  createdAt: number
}

export interface CreateSessionInput {
  id?: string
  title?: string
  provider: string
  model: string
  tier: TierId
  cwd: string
  policy: SandboxPolicy
}

interface SessionRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  provider: string
  model: string
  tier: string
  cwd: string
  policy: string
  tokens_in: number
  tokens_out: number
}

interface MessageRow {
  seq: number
  role: string
  json: string
  created_at: number
}

const UNTITLED = "untitled"

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    provider: row.provider,
    model: row.model,
    tier: row.tier as TierId,
    cwd: row.cwd,
    policy: parsePolicy(row.policy),
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
  }
}

/**
 * A stored policy is untrusted input: it can come from an older schema version, a hand-edited
 * database, or a partially written row. `clonePolicy` immediately does `[...policy.network.hosts]`,
 * so a missing field throws on resume with an error that points nowhere near the real cause.
 * Anything unusable falls back to the defaults rather than refusing to open the session.
 */
function parsePolicy(json: string): SandboxPolicy {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return clonePolicy(DEFAULT_POLICY)
  }
  if (raw === null || typeof raw !== "object") return clonePolicy(DEFAULT_POLICY)

  const candidate = raw as Partial<SandboxPolicy>
  const base = clonePolicy(DEFAULT_POLICY)
  const arrays = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined

  const fs = (candidate.fs ?? {}) as Partial<SandboxPolicy["fs"]>
  const network = (candidate.network ?? {}) as Partial<SandboxPolicy["network"]>
  const commands = (candidate.commands ?? {}) as Partial<SandboxPolicy["commands"]>
  const env = (candidate.env ?? {}) as Partial<SandboxPolicy["env"]>

  const merged: SandboxPolicy = {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : base.enabled,
    strict: typeof candidate.strict === "boolean" ? candidate.strict : base.strict,
    network: {
      mode: NET_MODES.includes(network.mode as NetMode) ? (network.mode as NetMode) : base.network.mode,
      hosts: arrays(network.hosts) ?? base.network.hosts,
      ...(typeof network.proxyUrl === "string" ? { proxyUrl: network.proxyUrl } : {}),
    },
    fs: {
      ro: arrays(fs.ro) ?? base.fs.ro,
      rw: arrays(fs.rw) ?? base.fs.rw,
      hidden: arrays(fs.hidden) ?? base.fs.hidden,
      tmpfs: arrays(fs.tmpfs) ?? base.fs.tmpfs,
    },
    commands: {
      deny: arrays(commands.deny) ?? base.commands.deny,
      ...(arrays(commands.allow) ? { allow: arrays(commands.allow) as string[] } : {}),
    },
    limits: (() => {
      let limits: SandboxPolicy["limits"] = base.limits
      if (typeof candidate.limits === "object" && candidate.limits !== null) {
        limits = candidate.limits as SandboxPolicy["limits"]
        const legacy = (candidate.limits as Record<string, unknown>).cpus
        if (limits.cpuSeconds === undefined && typeof legacy === "number") {
          limits = { ...limits, cpuSeconds: legacy }
        }
      }
      return limits
    })(),
    env: {
      pass: arrays(env.pass) ?? base.env.pass,
      scrub: arrays(env.scrub) ?? base.env.scrub,
    },
  }
  // A stored policy is untrusted, so a merged result that still violates the policy invariants
  // (relative paths, strict-without-sandbox, a hidden path over a writable root, ...) falls back
  // to the defaults instead of being handed to the sandbox compiler, which would either refuse at
  // runtime or, worse, accept something the audit said must never survive a resume.
  if (validatePolicy(merged).length > 0) return clonePolicy(DEFAULT_POLICY)
  return merged
}

export class SqliteSessionStore {
  readonly #db: DatabaseSync
  #lastStamp = 0

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  /**
   * Monotonic millisecond stamps. `Date.now()` alone collides when several writes land in the same
   * millisecond, which makes "newest first" ordering jitter for no reason.
   */
  #stamp(): number {
    const now = Date.now()
    this.#lastStamp = now > this.#lastStamp ? now : this.#lastStamp + 1
    return this.#lastStamp
  }

  create(input: CreateSessionInput): SessionRecord {
    const now = this.#stamp()
    const id = input.id ?? newId("ses")
    this.#db
      .prepare(
        `INSERT INTO sessions (id, title, created_at, updated_at, provider, model, tier, cwd, policy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title ?? UNTITLED,
        now,
        now,
        input.provider,
        input.model,
        input.tier,
        input.cwd,
        JSON.stringify(input.policy),
      )
    const created = this.get(id)
    if (!created) throw new Error(`failed to create session ${id}`)
    return created
  }

  get(id: string): SessionRecord | null {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined
    return row ? toRecord(row) : null
  }

  list(options: { limit?: number; match?: string } = {}): SessionRecord[] {
    const limit = options.limit ?? 20
    if (options.match && options.match.length > 0) {
      // `%` and `_` in the search text are LIKE wildcards, so `match: "%"` matched every session.
      // Escaping them keeps a search literal.
      const escaped = options.match.replace(/[\\%_]/g, (char) => `\\${char}`)
      const rows = this.#db
        .prepare("SELECT * FROM sessions WHERE title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?")
        .all(`%${escaped}%`, limit) as unknown as SessionRow[]
      return rows.map(toRecord)
    }
    const rows = this.#db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as unknown as SessionRow[]
    return rows.map(toRecord)
  }

  rename(id: string, title: string): void {
    this.#db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, this.#stamp(), id)
  }

  delete(id: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(id)
  }

  setModel(id: string, provider: string, model: string, tier: TierId): void {
    this.#db
      .prepare("UPDATE sessions SET provider = ?, model = ?, tier = ?, updated_at = ? WHERE id = ?")
      .run(provider, model, tier, this.#stamp(), id)
  }

  /**
   * Append-only. The first user message also names the session, which is why resumed sessions in
   * `byoa sessions` are recognisable instead of a wall of "untitled".
   */
  appendMessage(sessionId: string, message: ProviderMessage): void {
    const now = this.#stamp()
    this.#db
      .prepare("INSERT INTO messages (session_id, role, json, created_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, message.role, JSON.stringify(message), now)
    this.#db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId)

    if (message.role === "user") {
      const session = this.get(sessionId)
      if (session && session.title === UNTITLED) {
        this.rename(sessionId, titleFrom(message.content))
      }
    }
  }

  getMessages(sessionId: string, options: { fromSeq?: number; limit?: number } = {}): StoredMessage[] {
    const from = options.fromSeq ?? 0
    const rows = (
      options.limit === undefined
        ? this.#db
            .prepare("SELECT seq, role, json, created_at FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq")
            .all(sessionId, from)
        : this.#db
            .prepare(
              "SELECT seq, role, json, created_at FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            )
            .all(sessionId, from, options.limit)
    ) as unknown as MessageRow[]
    return rows.map((row) => ({
      seq: row.seq,
      role: row.role,
      message: JSON.parse(row.json) as ProviderMessage,
      createdAt: row.created_at,
    }))
  }

  addUsage(sessionId: string, input: number, output: number): void {
    this.#db
      .prepare("UPDATE sessions SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE id = ?")
      .run(input, output, sessionId)
  }

  /** The adapter the agent talks to, so the core never sees SQL. */
  toPersistence(sessionId: string): AgentPersistence {
    return {
      // Async on the way out: a foreign-key violation used to throw synchronously from inside a
      // function whose type says it returns a promise, which defeats `.catch()` at the call site.
      appendMessage: async (message) => {
        this.appendMessage(sessionId, message)
      },
      addUsage: async (input, output) => {
        this.addUsage(sessionId, input, output)
      },
    }
  }

  close(): void {
    this.#db.close()
  }
}

export function titleFrom(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "untitled"
  const trimmed = firstLine.trim()
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed
}
