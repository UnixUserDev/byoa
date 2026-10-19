import type { MemorySettings } from "../config/schema.ts"
import type { MemoryStore } from "./types.ts"
import { ObsidianMemoryStore } from "./obsidian.ts"
import { SqliteMemoryStore } from "./sqlite.ts"

/**
 * Build the memory store from config.
 *
 * `namespace` is the isolation boundary: byoa passes "byoa" so it only sees notes it wrote, under
 * `<vault>/memory/byoa/`. An empty namespace means "read the whole vault" - which is what a
 * generic reader (not byoa) should use.
 */
export function createMemoryStore(settings: MemorySettings, fallbackNamespace = "byoa"): MemoryStore {
  const namespace = settings.namespace ?? fallbackNamespace
  if (settings.backend === "sqlite") return new SqliteMemoryStore(settings.sqlitePath, namespace)
  return new ObsidianMemoryStore(settings.vault, namespace)
}

export { ObsidianMemoryStore } from "./obsidian.ts"
export { SqliteMemoryStore } from "./sqlite.ts"
export type { MemoryStore, MemoryNote, RecallHit, RecallInput, RememberInput } from "./types.ts"
