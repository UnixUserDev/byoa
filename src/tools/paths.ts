import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { realpathSync } from "node:fs"
import type { SandboxPolicy } from "../sandbox/policy.ts"

export function resolvePath(cwd: string, input: string): string {
  return isAbsolute(input) ? resolve(input) : resolve(cwd, input)
}

export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * Where a path *really* lands once symlinks are resolved.
 *
 * Lexical containment is not containment. A symlink inside a writable root pointing anywhere else
 * passes every string comparison and then the write follows it - `fs_write {path: root/link/x}`
 * happily writes outside the root. `resolvePath` cannot see this because it never touches the disk.
 *
 * The deepest existing ancestor is resolved and the non-existent tail is re-appended, so this also
 * answers the question for a file that is about to be created (whose parent `fs_write` will make).
 */
export function realPath(path: string): string {
  const absolute = resolve(path)
  const tail: string[] = []
  let current = absolute
  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length === 0 ? real : resolve(real, ...[...tail].reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.push(basename(current))
      current = parent
    }
  }
}

/**
 * True when `path` cannot be reached from any of `roots`, judging by where it really resolves to.
 * A root that does not exist is compared lexically, since there is nothing to resolve.
 */
function escapes(roots: string[], path: string): boolean {
  const target = realPath(path)
  return !roots.some((root) => isWithin(realPath(root), target))
}

/** A path under a hidden or tmpfs entry is invisible to the shell, so the tools must agree. */
function hiddenBy(policy: SandboxPolicy, path: string): string | null {
  const real = realPath(path)
  for (const dir of [...policy.fs.hidden, ...policy.fs.tmpfs]) {
    if (isWithin(dir, path) || isWithin(dir, real)) return `'${path}' is hidden by sandbox policy`
  }
  return null
}

/**
 * Tools enforce the policy themselves as well as the sandbox enforcing it.
 *
 * The sandbox is the real boundary, but two things justify checking here too: the sandbox can be
 * disabled or degraded, and a clear "outside the writable roots" error is far more useful to the
 * model than a mysterious EROFS from inside a namespace.
 */
export function checkRead(policy: SandboxPolicy, path: string): string | null {
  const hidden = hiddenBy(policy, path)
  if (hidden) return hidden
  const roots = [...policy.fs.ro, ...policy.fs.rw]
  // Fails closed, not open: "no readable roots configured" must not mean "read everything".
  if (roots.length === 0) return `'${path}' is outside the readable roots (none are configured)`
  return escapes(roots, path) ? `'${path}' is outside the readable roots` : null
}

export function checkWrite(policy: SandboxPolicy, path: string): string | null {
  const hidden = hiddenBy(policy, path)
  if (hidden) return hidden
  if (policy.fs.rw.length === 0) return `'${path}' is not writable (no writable roots configured)`
  return escapes(policy.fs.rw, path)
    ? `'${path}' is outside the writable roots (${policy.fs.rw.join(", ")})`
    : null
}
