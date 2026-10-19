import { homedir } from "node:os"
import { join } from "node:path"
import { clonePolicy, DEFAULT_POLICY } from "../sandbox/policy.ts"
import { BUILTIN_PROVIDERS } from "./presets.ts"
import type { ByoaConfig } from "./schema.ts"

export function defaultVaultPath(): string {
  return process.env.BYOA_VAULT ?? join(homedir(), "Documents", "Obsidian Vault")
}

export function DEFAULT_CONFIG(): ByoaConfig {
  const home = homedir()
  const sandbox = clonePolicy(DEFAULT_POLICY)
  // Defence in depth. With the skeleton root, `$HOME` is not mounted at all, so these are already
  // absent - this list only starts doing work if someone deliberately mounts `$HOME` read-only.
  // The vault is deliberately NOT hidden: byoa reads memory as itself, not through the shell.
  sandbox.fs.hidden = [
    join(home, ".ssh"),
    join(home, ".gnupg"),
    join(home, ".aws"),
    join(home, ".kube"),
    join(home, ".docker"),
    join(home, ".netrc"),
    join(home, ".git-credentials"),
    join(home, ".config", "gh"),
    join(home, ".config", "gcloud"),
    join(home, ".config", "byoa"),
    join(home, ".config", "opencode"),
    join(home, ".local", "share", "keyrings"),
  ]

  return {
    defaults: { provider: "fake", tier: "auto" },
    providers: BUILTIN_PROVIDERS.map((provider) => ({ ...provider })),
    sandbox,
    memory: {
      backend: "obsidian",
      vault: defaultVaultPath(),
      recall: { limit: 4, budgetTokens: 800 },
    },
    store: { path: "" },
  }
}
