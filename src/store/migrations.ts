import type { DatabaseSync } from "node:sqlite"
import { SCHEMA_SQL } from "./schema.ts"

export const SCHEMA_VERSION = 1

/**
 * Versioned on `PRAGMA user_version`. Idempotent: every statement is IF NOT EXISTS, so running it
 * against an already-migrated database is a no-op rather than an error.
 */
export function migrate(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number | bigint } | undefined
  const current = Number(row?.user_version ?? 0)
  if (current >= SCHEMA_VERSION) return current

  db.exec(SCHEMA_SQL)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  return SCHEMA_VERSION
}
