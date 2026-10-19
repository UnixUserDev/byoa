import type { SandboxPolicy } from "./policy.ts"

/**
 * Environment hygiene.
 *
 * Two things go wrong without this. First, a sandboxed child inheriting the parent environment
 * carries the user's API keys into a shell the model drives - so inside the sandbox we clear the
 * environment and pass only an explicit allowlist. Second, the OpenCode AppImage leaks
 * LD_LIBRARY_PATH into every child process on this machine, which makes system binaries load the
 * wrong libraries; that is a documented failure on this box and it would otherwise follow us into
 * the sandbox.
 */
export function scrubEnvironment(
  policy: SandboxPolicy,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (policy.env.scrub.includes(name)) continue
    result[name] = value
  }
  return result
}

/** Just the variables the policy allows across the sandbox boundary. */
export function allowedEnvironment(
  policy: SandboxPolicy,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of policy.env.pass) {
    const value = source[name]
    if (value !== undefined && value.length > 0) result[name] = value
  }
  return result
}

/**
 * The environment for the paths that are NOT wrapped in bubblewrap: `--no-sandbox`, and the
 * degradation when bubblewrap is missing.
 *
 * This deliberately uses the same allowlist as the sandboxed path. The old behaviour scrubbed a
 * four-variable denylist of `LD_*` names, which left every `*_API_KEY`, `GH_TOKEN` and `AWS_*`
 * variable sitting in the model-driven shell - one injected `echo` from total disclosure. An
 * allowlist is the only shape that survives a variable nobody thought to list.
 */
export function unwrappedEnvironment(
  policy: SandboxPolicy,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result = allowedEnvironment(policy, source)
  if (result.PATH === undefined && source.PATH !== undefined) result.PATH = source.PATH
  return result
}
