import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "./defaults.ts"
import type { ByoaConfig, ProviderSettings } from "./schema.ts"

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

  return { config, path, warnings, found: true }
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
