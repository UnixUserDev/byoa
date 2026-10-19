/**
 * The sandbox is a policy object first and a bubblewrap invocation second.
 *
 * Everything the agent is allowed to touch is described here, so it can be shown in a status
 * bar, tightened mid-session, and diffed when it changes. `compile.ts` is the only place that
 * knows how to turn this into a `bwrap` argv.
 */

export const NET_MODES = ["deny", "allow-all", "proxy-allowlist"] as const
export type NetMode = (typeof NET_MODES)[number]

export interface SandboxPolicy {
  /** When false the process runs with no isolation at all. Loudly warned about, never silent. */
  enabled: boolean
  /** When true, a missing bubblewrap is a hard failure instead of a loud degradation. */
  strict: boolean
  network: {
    mode: NetMode
    /** Only meaningful for `proxy-allowlist`, which is not implemented yet. */
    hosts: string[]
    proxyUrl?: string
  }
  fs: {
    /** Mounted read-only. */
    ro: string[]
    /** Bind-mounted read-write. The workspace is added here at session start. */
    rw: string[]
    /** Shadowed with an empty tmpfs, so secrets under HOME are invisible. */
    hidden: string[]
    tmpfs: string[]
  }
  commands: {
    /** Executable names refused before the sandbox even starts. */
    deny: string[]
    /** When set, the executable must be in this list. */
    allow?: string[]
  }
  limits: {
    /**
     * Limits are applied by prefixing the command with `ulimit` inside the shell we already spawn,
     * because bubblewrap 0.13.1 has no `--rlimit-*` options. A limit the kernel refuses is reported
     * on stderr rather than silently skipped.
     */
    /** Total CPU seconds (`ulimit -t`). This is CPU time, not a core count - bwrap cannot cap cores. */
    cpuSeconds?: number
    /** Address-space ceiling in MiB (`ulimit -v`), i.e. memory per process. */
    memoryMB?: number
    /** Process count (`ulimit -u`). */
    pids?: number
    /** Open file descriptors (`ulimit -n`). */
    nofile?: number
    /** Hard wall-clock ceiling for a single command, enforced by the runner. */
    wallClockMs?: number
  }
  env: {
    pass: string[]
    scrub: string[]
  }
}

/**
 * LD_LIBRARY_PATH is in the scrub list on purpose. The OpenCode AppImage leaks it into every
 * child process on this box, which makes system binaries load the wrong libraries - a known
 * failure mode documented in the vault, and one that would otherwise follow us into the sandbox.
 */
export const DEFAULT_POLICY: SandboxPolicy = {
  enabled: true,
  // Fail closed. If bubblewrap is missing, mutating commands refuse instead of quietly running
  // against the real host with the real environment. `--no-strict` is the explicit opt-out.
  strict: true,
  network: { mode: "deny", hosts: [] },
  fs: {
    // This is a read-ALLOWLIST, not a denylist: nothing outside these roots exists inside the
    // sandbox. `/run` is deliberately absent - it holds the session D-Bus socket and systemd's
    // resolver socket, so mounting it would make "network denied" leak name resolution and hand
    // the sandbox a route to user daemons. If a tool needs something here, name it explicitly.
    ro: ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc"],
    rw: [],
    hidden: [],
    // Empty on purpose. Inside the sandbox HOME is the workspace, so agents get scratch space
    // without a tmpfs: mounting one over /tmp would shadow any writable root that lives under it,
    // because bubblewrap applies mounts in order.
    tmpfs: [],
  },
  commands: {
    deny: ["sudo", "su", "pkexec", "mount", "umount", "reboot", "shutdown", "systemctl", "dd"],
  },
  limits: { wallClockMs: 120_000 },
  env: {
    pass: ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TZ"],
    scrub: ["LD_LIBRARY_PATH", "LD_PRELOAD", "LD_AUDIT", "DYLD_INSERT_LIBRARIES"],
  },
}

export function clonePolicy(policy: SandboxPolicy): SandboxPolicy {
  return {
    enabled: policy.enabled,
    strict: policy.strict,
    network: { mode: policy.network.mode, hosts: [...policy.network.hosts], ...(policy.network.proxyUrl ? { proxyUrl: policy.network.proxyUrl } : {}) },
    fs: {
      ro: [...policy.fs.ro],
      rw: [...policy.fs.rw],
      hidden: [...policy.fs.hidden],
      tmpfs: [...policy.fs.tmpfs],
    },
    commands: { deny: [...policy.commands.deny], ...(policy.commands.allow ? { allow: [...policy.commands.allow] } : {}) },
    limits: { ...policy.limits },
    env: { pass: [...policy.env.pass], scrub: [...policy.env.scrub] },
  }
}

/**
 * A deep-partial view of the policy, so callers can change `fs.rw` without restating the whole
 * `fs` object. Arrays are replaced wholesale, never appended to - that keeps a policy change
 * auditable ("rw is now exactly this list") instead of accumulating silent grants.
 */
export interface SandboxPolicyPatch {
  enabled?: boolean
  strict?: boolean
  network?: { mode?: NetMode; hosts?: string[]; proxyUrl?: string }
  fs?: { ro?: string[]; rw?: string[]; hidden?: string[]; tmpfs?: string[] }
  commands?: { deny?: string[]; allow?: string[] }
  limits?: SandboxPolicy["limits"]
  env?: { pass?: string[]; scrub?: string[] }
}

export function mergePolicy(base: SandboxPolicy, patch: SandboxPolicyPatch): SandboxPolicy {
  const merged = clonePolicy(base)
  if (patch.enabled !== undefined) merged.enabled = patch.enabled
  if (patch.strict !== undefined) merged.strict = patch.strict
  if (patch.network) {
    if (patch.network.mode !== undefined) merged.network.mode = patch.network.mode
    if (patch.network.hosts !== undefined) merged.network.hosts = [...patch.network.hosts]
    if (patch.network.proxyUrl !== undefined) merged.network.proxyUrl = patch.network.proxyUrl
  }
  if (patch.fs) {
    if (patch.fs.ro !== undefined) merged.fs.ro = [...patch.fs.ro]
    if (patch.fs.rw !== undefined) merged.fs.rw = [...patch.fs.rw]
    if (patch.fs.hidden !== undefined) merged.fs.hidden = [...patch.fs.hidden]
    if (patch.fs.tmpfs !== undefined) merged.fs.tmpfs = [...patch.fs.tmpfs]
  }
  if (patch.commands) {
    if (patch.commands.deny !== undefined) merged.commands.deny = [...patch.commands.deny]
    if (patch.commands.allow !== undefined) merged.commands.allow = [...patch.commands.allow]
  }
  if (patch.limits) merged.limits = { ...merged.limits, ...patch.limits }
  if (patch.env) {
    if (patch.env.pass !== undefined) merged.env.pass = [...patch.env.pass]
    if (patch.env.scrub !== undefined) merged.env.scrub = [...patch.env.scrub]
  }
  return merged
}

/** Returns a list of human-readable problems. Empty means the policy is usable. */
export function validatePolicy(policy: SandboxPolicy): string[] {
  const problems: string[] = []
  if (!NET_MODES.includes(policy.network.mode)) problems.push(`unknown network mode: ${String(policy.network.mode)}`)
  if (policy.network.mode === "proxy-allowlist" && !policy.network.proxyUrl) {
    problems.push("network mode 'proxy-allowlist' requires a proxyUrl")
  }
  for (const path of [...policy.fs.ro, ...policy.fs.rw]) {
    if (!path.startsWith("/")) problems.push(`filesystem path must be absolute: ${path}`)
  }
  if (policy.fs.ro.some((path) => policy.fs.rw.includes(path))) {
    problems.push("a path cannot be both read-only and read-write")
  }
  if (!policy.enabled && policy.strict) problems.push("strict has no meaning when the sandbox is disabled")
  if (policy.enabled && !policy.fs.ro.some((root) => root === "/usr" || root === "/bin")) {
    problems.push(
      "the read-only roots name neither /usr nor /bin, so nothing can execute inside the sandbox - add the runtime directories your tools need",
    )
  }
  for (const shadow of [...policy.fs.hidden, ...policy.fs.tmpfs]) {
    for (const root of policy.fs.rw) {
      if (root === shadow || root.startsWith(`${shadow}/`)) {
        problems.push(
          `'${shadow}' would be mounted over the writable root '${root}' - bubblewrap applies mounts in order, so the bind destination would vanish and the command would fail`,
        )
      }
    }
  }
  const wall = policy.limits.wallClockMs
  if (wall !== undefined && wall <= 0) problems.push("limits.wallClockMs must be positive")
  for (const [name, value] of [
    ["cpuSeconds", policy.limits.cpuSeconds],
    ["memoryMB", policy.limits.memoryMB],
    ["pids", policy.limits.pids],
    ["nofile", policy.limits.nofile],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      problems.push(`limits.${name} must be a positive integer`)
    }
  }
  return problems
}

/**
 * The `ulimit` prefix that enforces `policy.limits` inside the spawned shell.
 *
 * A failed `ulimit` is reported to stderr instead of being swallowed: a limit that silently did not
 * apply is worse than no limit, because the policy claimed it did.
 */
export function limitPreamble(policy: SandboxPolicy): string {
  const limits = policy.limits
  const parts: string[] = []
  const apply = (flag: string, value: number, label: string): void => {
    parts.push(`ulimit ${flag} ${value} 2>/dev/null || echo "byoa: could not apply ${label} limit" >&2`)
  }
  if (limits.nofile !== undefined) apply("-n", limits.nofile, "nofile")
  if (limits.pids !== undefined) apply("-u", limits.pids, "pids")
  if (limits.memoryMB !== undefined) apply("-v", limits.memoryMB * 1024, "memory")
  if (limits.cpuSeconds !== undefined) apply("-t", limits.cpuSeconds, "cpu")
  return parts.length === 0 ? "" : `${parts.join("; ")}; `
}

function basename(token: string): string {
  const base = token.split("/").pop() ?? token
  return base
}

/**
 * Shell words that introduce another command. Without following these, `sh -c 'dd ...'` and
 * `xargs dd ...` walk straight past an executable deny-list.
 */
const RUNNERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "ksh",
  "env",
  "xargs",
  "nohup",
  "timeout",
  "nice",
  "ionice",
  "command",
  "exec",
  "doas",
  "setsid",
  "stdbuf",
])

const SHELL_OPERATOR = /^[;&|()<>`]+$/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * The command names that appear in command position: after a shell operator, at the start, and
 * after a runner like `sh -c` / `env` / `xargs`. Arguments are not treated as commands, so
 * `cat /tmp/dd` is not mistaken for a `dd` invocation.
 */
export function commandPositions(command: string): string[] {
  const words = command.match(/[;&|()<>`]+|\S+/g) ?? []
  const found: string[] = []
  let expectCommand = true
  let runnerArmed = false
  for (const raw of words) {
    if (SHELL_OPERATOR.test(raw)) {
      expectCommand = true
      runnerArmed = false
      continue
    }
    const word = raw.replace(/^["']+|["']+$/g, "")
    if (word.length === 0) continue
    if (expectCommand && ASSIGNMENT.test(word)) continue // `FOO=1 dd ...` - still expecting a command
    if (word.startsWith("-")) continue // a flag; a pending runner stays armed
    if (expectCommand) {
      const name = basename(word)
      found.push(name)
      expectCommand = false
      runnerArmed = RUNNERS.has(name)
      continue
    }
    if (runnerArmed) {
      found.push(basename(word))
      runnerArmed = false
    }
  }
  return found
}

/**
 * Returns the offending executable name, or null. This is a speed bump, not a boundary: the
 * sandbox is what actually contains a command. It exists so an accidentally-destructive command
 * is refused before it starts, and it is honest about only understanding shell words, not shell
 * semantics - obfuscation (`$(echo dd)`) still defeats it, by design, because faking a boundary
 * is worse than not having one.
 *
 * The allowlist mode can only judge the first word, because there is no way to tell a path
 * argument from a command name without a real parser - so it stays first-token-only.
 */
export function deniedCommand(policy: SandboxPolicy, command: string): string | null {
  const first = commandPositions(command)[0] ?? basename(command.trim().split(/\s+/)[0] ?? "")
  if (policy.commands.allow && policy.commands.allow.length > 0) {
    return policy.commands.allow.includes(first) ? null : first
  }
  for (const candidate of commandPositions(command)) {
    if (policy.commands.deny.includes(candidate)) return candidate
  }
  return null
}

/** True when a command name is refused by policy. Kept for callers that already have a name. */
export function commandDenied(policy: SandboxPolicy, executable: string): boolean {
  const base = basename(executable)
  if (policy.commands.allow && policy.commands.allow.length > 0) return !policy.commands.allow.includes(base)
  return policy.commands.deny.includes(base)
}
