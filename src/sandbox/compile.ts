import { existsSync, lstatSync, readlinkSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { SandboxPolicy } from "./policy.ts"
import { deniedCommand, limitPreamble } from "./policy.ts"
import { allowedEnvironment } from "./envscrub.ts"

/**
 * Policy in, bwrap argv out. Pure, so it is table-testable and so the exact command that will run
 * can be shown to a human before it runs.
 *
 * ## Why there is no `--ro-bind / /` here
 *
 * The obvious recipe is `--ro-bind / /` plus a writable bind for the workspace. It is also a
 * security hole: it hands the sandboxed process a read-only copy of the *entire* host filesystem,
 * so every secret on the machine is one `cat` away and the only thing stopping it is a denylist of
 * paths - which is a list you will always forget to update. A read-allowlist is the correct shape.
 *
 * So this builds a skeleton root instead: only `policy.fs.ro` and `policy.fs.rw` are mounted, and
 * everything else simply does not exist in the namespace. `$HOME` is not mounted, which means API
 * keys, `devices.txt`, the Obsidian vault and `/run/user/1000`'s session bus are not merely
 * unreadable - they are absent.
 *
 * Verified on this box (bubblewrap 0.13.1, unprivileged userns, Arch's symlinked /bin and /lib):
 *   - the sandbox sees only the mounted roots; `/home`, `/run` and `/OpenCode-Sandbox` are missing
 *   - bwrap creates bind destinations inside its own writable root, so nested paths work
 *   - `--unshare-all` gives a netns with loopback only; with `/run` absent, DNS resolution dies too
 *   - `--clearenv` plus an allowlist keeps credentials out of the child
 *   - `--tmpfs` shadows are only meaningful for paths inside a mounted root, so we only emit those
 */
export interface CompileOptions {
  cwd: string
  command: string
  env?: NodeJS.ProcessEnv
  /** Injected for tests so we do not depend on the real filesystem layout. */
  exists?: (path: string) => boolean
}

export interface CompiledCommand {
  argv: string[]
  sandboxed: boolean
  deniedReason?: string
  degradedReason?: string
}

export function firstToken(command: string): string {
  const trimmed = command.trim()
  if (trimmed.length === 0) return ""
  const match = /^\S+/.exec(trimmed)
  return match ? match[0] : ""
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * A `--tmpfs` shadow only does anything for a path that would otherwise be visible through one of
 * the mounted roots. Emitting one for an unmounted path at best wastes an argument and at worst
 * makes bubblewrap fail on a destination it cannot create, so filter them.
 */
function isVisible(mountedRoots: string[], path: string): boolean {
  return mountedRoots.some((root) => isInside(root, path))
}

/**
 * The directories that are symlinks into `/usr` on Arch and its relatives. This is not a detail:
 * with only `/usr` mounted, a stock Arch root has no `/bin`, so every command dies with
 * `bwrap: execvp /bin/sh: No such file or directory` and the sandbox looks broken rather than
 * strict.
 *
 * So recreate them - but only when the symlink exists on the host, its target is actually mounted,
 * and the destination is not already supplied by a bind (on Debian `/bin` is a real directory).
 */
const FHS_SYMLINKS = ["/bin", "/sbin", "/lib", "/lib64"]

function standardSymlinks(mountedRoots: string[]): Array<[string, string]> {
  const links: Array<[string, string]> = []
  for (const dir of FHS_SYMLINKS) {
    if (mountedRoots.includes(dir)) continue
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(dir)
    } catch {
      continue
    }
    if (!stat.isSymbolicLink()) continue
    let target: string
    try {
      target = readlinkSync(dir)
    } catch {
      continue
    }
    const absolute = isAbsolute(target) ? target : resolve(dirname(dir), target)
    if (mountedRoots.some((root) => root === absolute || isInside(root, absolute))) {
      links.push([absolute, dir])
    }
  }
  return links
}

export function compileCommand(policy: SandboxPolicy, options: CompileOptions): CompiledCommand {
  const exists = options.exists ?? existsSync
  const env = options.env ?? process.env

  const denied = deniedCommand(policy, options.command)
  if (denied !== null) {
    return { argv: [], sandboxed: false, deniedReason: `command '${denied}' is denied by sandbox policy` }
  }

  if (!policy.enabled) {
    return {
      argv: ["/bin/sh", "-c", `${limitPreamble(policy)}${options.command}`],
      sandboxed: false,
      degradedReason: "sandbox disabled by policy",
    }
  }

  const roRoots = unique(policy.fs.ro).filter((root) => exists(root))
  const rwRoots = unique(policy.fs.rw).filter((root) => exists(root))
  const mounted = [...roRoots, ...rwRoots]

  const argv: string[] = ["bwrap"]

  // Read-only roots first. No blanket `/`: a path that is not listed here does not exist inside.
  for (const root of roRoots) argv.push("--ro-bind", root, root)

  // `/bin/sh` has to exist or nothing runs at all; on symlink-into-/usr distros that means
  // recreating `/bin -> /usr/bin` and friends inside the skeleton root.
  for (const [target, link] of standardSymlinks(mounted)) argv.push("--symlink", target, link)

  // The pseudo-filesystems a shell and most tools require. /proc is mounted fresh per namespace,
  // which is also why /proc/net reflects the isolated network view rather than the host's.
  argv.push("--proc", "/proc", "--dev", "/dev")

  // Writable roots go on after the read-only ones so they win where they overlap.
  for (const root of rwRoots) argv.push("--bind", root, root)

  // Shadowing comes last: bubblewrap applies mounts in order, so this is what makes a hidden path
  // win over a bind that would otherwise expose it.
  for (const dir of unique(policy.fs.hidden)) {
    if (exists(dir) && isVisible(mounted, dir)) argv.push("--tmpfs", dir)
  }
  for (const dir of unique(policy.fs.tmpfs)) {
    if (exists(dir) && isVisible(mounted, dir)) argv.push("--tmpfs", dir)
  }

  let degradedReason: string | undefined
  if (policy.network.mode === "allow-all") {
    argv.push("--unshare-all", "--share-net")
  } else {
    argv.push("--unshare-all")
    if (policy.network.mode === "proxy-allowlist") {
      degradedReason = "network mode 'proxy-allowlist' is not implemented - network is denied"
    }
  }

  argv.push("--die-with-parent", "--new-session")

  // The environment is how credentials escape, so it is cleared and then rebuilt from an allowlist.
  argv.push("--clearenv")
  for (const [name, value] of Object.entries(allowedEnvironment(policy, env))) {
    argv.push("--setenv", name, value)
  }
  argv.push("--setenv", "HOME", options.cwd)
  argv.push("--chdir", options.cwd)
  argv.push("--", "/bin/sh", "-c", `${limitPreamble(policy)}${options.command}`)

  return degradedReason === undefined ? { argv, sandboxed: true } : { argv, sandboxed: true, degradedReason }
}

/** A human-readable description of the effective isolation, for the status line. */
export function describePolicy(policy: SandboxPolicy): string {
  const network = policy.network.mode === "allow-all" ? "net on" : "net off"
  return `${policy.enabled ? "sandbox" : "NO SANDBOX"} | ${network} | rw: ${policy.fs.rw.join(", ") || "none"}`
}
