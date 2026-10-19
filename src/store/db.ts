import { DatabaseSync } from "node:sqlite"
import { mkdirSync, chmodSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

/**
 * One place opens a database, so the day `node:sqlite` changes its API there is exactly one file
 * to fix. It is still marked experimental in Node, and this is the containment strategy for that.
 */
export function defaultDatabasePath(): string {
  const override = process.env.BYOA_DB
  if (override && override.length > 0) return override
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(dataHome, "byoa", "byoa.db")
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    // Session history is a de-facto secret store: it holds whatever the model ever read, verbatim.
    // Default umask leaves it world-readable, so both the directory and the file are tightened.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  }
  const db = new DatabaseSync(path)
  if (path !== ":memory:") {
    try {
      chmodSync(path, 0o600)
    } catch {
      // A filesystem that refuses chmod (or a pre-created file we do not own) is not fatal here.
    }
  }
  // WAL so a resumed session and a long-running one never fight over the file.
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA synchronous = NORMAL")
  return db
}
