import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

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
  const home = resolve(homedir())
  const target = resolve(cwd)

  if (target === home) return "it is your home directory"
  if (target === resolve("/")) return "it is the filesystem root"
  if (target === dirname(home)) return `it is the parent of your home directory (${dirname(home)})`
  return null
}
