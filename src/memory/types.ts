/**
 * Long-term memory, Obsidian-first.
 *
 * The store writes plain markdown notes into the vault and keeps a local FTS5 index beside them.
 * Retrieval is budgeted in tokens, because the whole point of using a vault rather than stuffing
 * a database into the context window is that we only pull in what we need.
 */

export interface MemoryNote {
  path: string
  title: string
  /** Exactly one, by vault convention. It is a group, not a label. */
  tags: string[]
  created: string
  source: string
  body: string
}

export interface RecallInput {
  query: string
  limit: number
  tag?: string
  budgetTokens: number
  /** Paths already in context this session - never injected twice. */
  excludePaths?: string[]
}

export interface RecallHit {
  path: string
  title: string
  tag: string
  created: string
  snippet: string
  score: number
  tokens: number
}

export interface RememberInput {
  text: string
  /** Human-readable title, no dates. Becomes the filename. */
  title: string
  /** Exactly one group tag. */
  tag: string
  source: string
  sessionId?: string
}

export interface MemoryStore {
  recall(input: RecallInput): Promise<RecallHit[]>
  remember(input: RememberInput): Promise<{ path: string; rejected?: string }>
  list(options?: { tag?: string }): Promise<MemoryNote[]>
  forget(match: string): Promise<number>
  reindex(): Promise<{ count: number }>
  stats(): Promise<{ count: number; byTag: Record<string, number> }>
  close(): void
}
