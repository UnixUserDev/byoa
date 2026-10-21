import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

/** Resolve symlinks when the path exists; fall back to a lexical resolve otherwise. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Why a directory is too broad to use as the agent's workspace.
 *
 * The workspace becomes the sandbox's single read-write bind, so pointing it at `$HOME` means the
 * model can read and write everything you own. That is a decision worth making deliberately, not
 * something you get by launching the agent from your home directory out of habit.
 *
 * Returns null when the directory is fine.
 */
export function broadWorkspaceReason(cwd: string): string | null {
  // Realpath first: a symlink to $HOME is still $HOME once it is mounted.
  const home = canonical(homedir())
  const target = canonical(cwd)

  if (target === home) return "it is your home directory"
  if (target === canonical("/")) return "it is the filesystem root"
  if (target === canonical(dirname(home))) return `it is the parent of your home directory (${dirname(home)})`
  return null
}

/** Existence/type check for a workspace. Breadth is `broadWorkspaceReason`, which has an opt-out. */
export function workspaceProblem(cwd: string): string | null {
  try {
    if (!statSync(cwd).isDirectory()) return "it is not a directory"
  } catch {
    return "it does not exist"
  }
  return null
}
