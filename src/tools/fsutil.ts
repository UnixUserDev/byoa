import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { SandboxPolicy } from "../sandbox/policy.ts"
import { hasBubblewrap } from "../sandbox/detect.ts"

/**
 * Write a file without ever leaving the user with half of one.
 *
 * The file tools run in-process, so a crash or a full disk part-way through `writeFile` truncates
 * whatever was there. Writing a sibling temp file and renaming it is atomic on every filesystem
 * these tools are going to see, and the temp file is in the same directory so the rename cannot
 * cross a mount boundary.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const temp = join(dir, `.${basename(path)}.byoa-${process.pid}-${Date.now().toString(36)}.tmp`)
  await writeFile(temp, content, "utf8")
  try {
    await rename(temp, path)
  } catch (error: unknown) {
    try {
      await unlink(temp)
    } catch {
      // The temp file is already gone or unreachable; the original error is the useful one.
    }
    throw error
  }
}

/**
 * The file tools write with `node:fs`, in this process, with no bubblewrap in the picture - so
 * under `strict` there is no such thing as a safe unsandboxed write. The shell already refuses in
 * this situation and the fatal event promises that mutating tools will too; this is what makes that
 * promise true instead of scoped to one tool.
 */
export function sandboxRefusal(policy: SandboxPolicy): string | null {
  if (!policy.enabled || !policy.strict) return null
  if (hasBubblewrap()) return null
  return "refusing to write: sandbox is required (strict) but bubblewrap is unavailable"
}
