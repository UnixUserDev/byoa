import { execFileSync } from "node:child_process"

let cached: boolean | null = null

/**
 * Can we actually sandbox here?
 *
 * `bwrap --version` only proves the binary exists. It says nothing about whether the kernel lets
 * this user create a user namespace, and a box where bwrap is installed but namespaces are blocked
 * (some CI runners, hardened distros) would otherwise report `sandboxed: true` and then fail every
 * command with `execvp`. So we probe a real minimal sandbox once and cache the answer.
 */
export function hasBubblewrap(): boolean {
  if (cached !== null) return cached
  try {
    execFileSync("bwrap", ["--version"], { stdio: "ignore", timeout: 5_000 })
    execFileSync(
      "bwrap",
      [
        "--ro-bind",
        "/usr",
        "/usr",
        "--symlink",
        "/usr/bin",
        "/bin",
        "--ro-bind",
        "/etc",
        "/etc",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind",
        "/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--unshare-all",
        "--die-with-parent",
        "--",
        "/bin/true",
      ],
      { stdio: "ignore", timeout: 5_000 },
    )
    cached = true
  } catch {
    cached = false
  }
  return cached
}

/** Test hook. */
export function setBubblewrapAvailable(value: boolean | null): void {
  cached = value
}
