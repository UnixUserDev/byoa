import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "./defaults.ts"
import type { ByoaConfig, ProviderSettings } from "./schema.ts"
import type { McpServerConfig } from "../mcp/types.ts"

export function configPath(): string {
  const override = process.env.BYOA_CONFIG
  if (override && override.length > 0) return override
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(configHome, "byoa", "config.json")
}

export interface LoadedConfig {
  config: ByoaConfig
  path: string
  warnings: string[]
  /** False when the file does not exist and we are running on defaults. */
  found: boolean
}

/**
 * Defaults, then the config file on top. Providers merge by id so a file entry can override just
 * the base URL of a built-in preset without restating its dialect and key environment.
 */
export function loadConfig(path: string = configPath()): LoadedConfig {
  const warnings: string[] = []
  const config = DEFAULT_CONFIG()

  if (!existsSync(path)) {
    return { config, path, warnings, found: false }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error: unknown) {
    warnings.push(`could not parse ${path}: ${error instanceof Error ? error.message : String(error)} - using defaults`)
    return { config, path, warnings, found: true }
  }

  if (parsed === null || typeof parsed !== "object") {
    warnings.push(`${path} is not a JSON object - using defaults`)
    return { config, path, warnings, found: true }
  }

  const raw = parsed as Partial<ByoaConfig>

  if (raw.defaults) config.defaults = { ...config.defaults, ...raw.defaults }

  if (Array.isArray(raw.providers)) {
    for (const entry of raw.providers) {
      if (!entry || typeof entry.id !== "string") continue
      const existing = config.providers.findIndex((provider) => provider.id === entry.id)
      if (existing >= 0) {
        config.providers[existing] = mergeProvider(config.providers[existing] as ProviderSettings, entry)
      } else {
        config.providers.push(entry)
      }
    }
  }

  if (raw.sandbox) {
    config.sandbox = {
      ...config.sandbox,
      ...raw.sandbox,
      network: { ...config.sandbox.network, ...raw.sandbox.network },
      fs: { ...config.sandbox.fs, ...raw.sandbox.fs },
      commands: { ...config.sandbox.commands, ...raw.sandbox.commands },
      limits: (() => {
      const merged = { ...config.sandbox.limits, ...raw.sandbox.limits }
      const legacy = (raw.sandbox.limits as Record<string, unknown> | undefined)?.cpus
      if (merged.cpuSeconds === undefined && typeof legacy === "number") merged.cpuSeconds = legacy
      return merged
    })(),
      env: { ...config.sandbox.env, ...raw.sandbox.env },
    }
  }

  if (raw.memory) config.memory = { ...config.memory, ...raw.memory, recall: { ...config.memory.recall, ...raw.memory.recall } }
  if (raw.store) config.store = { ...config.store, ...raw.store }

  if (raw.plugins) {
    config.plugins = {
      ...config.plugins,
      ...raw.plugins,
      enabled: Array.isArray(raw.plugins.enabled)
        ? raw.plugins.enabled.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : config.plugins.enabled,
    }
  }

  if (raw.subagents) {
    const candidate = raw.subagents as unknown as Record<string, unknown>
    const depth = clampInt(candidate.maxDepth, config.subagents.maxDepth, 0, 8)
    const steps = clampInt(candidate.maxSteps, config.subagents.maxSteps, 1, 100)
    const tokens = clampInt(candidate.maxTokens, 0, 0, 1_000_000)
    config.subagents = {
      enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : config.subagents.enabled,
      maxDepth: depth,
      maxSteps: steps,
      // 0 is "no ceiling", which is the only way to express "unset" in JSON without a sentinel.
      ...(tokens > 0 ? { maxTokens: tokens } : {}),
    }
  }

  // Servers declared here win over a plugin's declaration of the same name (see composeMcpServers).
  // Entries without a usable name are dropped with a warning rather than becoming an unnamed
  // connection nobody can turn off.
  if (raw.mcp && Array.isArray(raw.mcp.servers)) {
    const servers: McpServerConfig[] = []
    for (const entry of raw.mcp.servers) {
      if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || entry.name.length === 0) {
        warnings.push("mcp: ignoring a server entry with no name")
        continue
      }
      servers.push(entry)
    }
    config.mcp = { servers }
  }

  return { config, path, warnings, found: true }
}

/**
 * JSON is not typed. A string `maxDepth` would make `depth >= maxDepth` compare against NaN -
 * always false - which silently removes the nesting ceiling instead of tightening it.
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  // `Number(null)` and `Number("")` are both 0, which would turn a null typo into "disable the
  // ceiling" (maxSteps 1, maxDepth 0). Only an actual number or numeric string gets used.
  if (value === null || value === undefined || value === "") return fallback
  const numeric = typeof value === "number" ? value : Number(value)
  if (typeof value !== "number" && typeof value !== "string") return fallback
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.floor(numeric)))
}

function mergeProvider(base: ProviderSettings, override: Partial<ProviderSettings>): ProviderSettings {
  return {
    ...base,
    ...override,
    headers: { ...base.headers, ...override.headers },
    capabilities: { ...base.capabilities, ...override.capabilities },
    models: { ...base.models, ...override.models },
  }
}
