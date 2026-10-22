import type { DatabaseSync } from "node:sqlite"
import { SCHEMA_SQL } from "./schema.ts"

export const SCHEMA_VERSION = 2

/**
 * Versioned on `PRAGMA user_version`, and stepped rather than stamped.
 *
 * The previous version ran one `SCHEMA_SQL` and wrote the version down. That is fine while every
 * table is `IF NOT EXISTS`, and silently wrong the moment a migration has to add a column: an
 * existing database skips the `CREATE TABLE`, the `ALTER` never ran, and the version says it did.
 * Each step below therefore checks the actual shape before touching it.
 */
export function migrate(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number | bigint } | undefined
  const current = Number(row?.user_version ?? 0)
  if (current >= SCHEMA_VERSION) return current

  db.exec("BEGIN")
  try {
    // v1: base tables. Idempotent for an existing database.
    db.exec(SCHEMA_SQL)
    if (current < 2) {
      // v2: parent_id links a subagent session to the session that spawned it.
      addColumnIfMissing(db, "sessions", "parent_id", "TEXT")
      db.exec("CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id)")
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec("COMMIT")
  } catch (error: unknown) {
    db.exec("ROLLBACK")
    throw error
  }
  return SCHEMA_VERSION
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
  return rows.some((row) => row.name === column)
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  if (hasColumn(db, table, column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}
