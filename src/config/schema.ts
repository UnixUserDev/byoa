import type { Dialect, ModelCapabilities } from "../providers/types.ts"
import type { SandboxPolicy } from "../sandbox/policy.ts"
import type { TierId } from "../prompts/tiers.ts"
import type { McpServerConfig } from "../mcp/types.ts"

export interface ProviderSettings {
  id: string
  dialect: Dialect
  baseUrl?: string
  /** Preferred: the name of an environment variable holding the key. */
  apiKeyEnv?: string
  /** Allowed, but a literal key in a config file is a warning and never logged. */
  apiKey?: string
  headers?: Record<string, string>
  /** Provider-wide capability assumptions. */
  capabilities?: Partial<ModelCapabilities>
  /** Per-model capability overrides, keyed by model id. */
  models?: Record<string, Partial<ModelCapabilities>>
}

export interface MemorySettings {
  backend: "obsidian" | "sqlite"
  vault?: string
  sqlitePath?: string
  /**
   * Subfolder of `<vault>/memory` this store may read and write. byoa defaults to "byoa" so it
   * cannot read notes written by another agent (or by the user), while a generic reader with an
   * empty namespace sees the whole vault.
   */
  namespace?: string
  recall: { limit: number; budgetTokens: number }
}

export interface PluginsSettings {
  /** Where plugins live. One `.ts`/`.mjs`/`.js` file, or a folder with an `index.*`. */
  dir: string
  /**
   * Allowlist. Empty means "load nothing": a plugin is code with your full privileges, so dropping
   * a file into the directory must not be enough to make it run.
   */
  enabled: string[]
}

export interface McpSettings {
  servers: McpServerConfig[]
}

export interface SubagentsSettings {
  /**
   * Whether the `task` tool is registered at all. Off means the model never learns it exists, which
   * keeps the tool schema (and therefore the cached prompt prefix) identical to previous releases.
   */
  enabled: boolean
  /** Nesting ceiling. 0 disables delegation entirely, including from the top-level agent. */
  maxDepth: number
  /** Step cap for one child run. */
  maxSteps: number
  /** Output-token ceiling for one child run. Unset means no ceiling. */
  maxTokens?: number
}

export interface ByoaConfig {
  defaults: {
    provider: string
    model?: string
    tier: TierId | "auto"
  }
  providers: ProviderSettings[]
  sandbox: SandboxPolicy
  memory: MemorySettings
  store: { path: string }
  plugins: PluginsSettings
  mcp: McpSettings
  subagents: SubagentsSettings
}
