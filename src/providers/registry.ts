import type { ByoaConfig, ProviderSettings } from "../config/schema.ts"
import { resolveApiKey } from "../config/secrets.ts"
import { FakeProvider } from "./fake.ts"
import { OpenAiCompatibleProvider } from "./openai-compat.ts"
import { AnthropicProvider } from "./anthropic.ts"
import type { ModelCapabilities, Provider } from "./types.ts"

export interface ResolvedProvider {
  settings: ProviderSettings
  apiKey?: string
  warnings: string[]
}

export function findProviderSettings(config: ByoaConfig, id: string): ProviderSettings | undefined {
  return config.providers.find((provider) => provider.id === id)
}

export function resolveProvider(config: ByoaConfig, id: string): ResolvedProvider {
  const settings = findProviderSettings(config, id)
  if (!settings) {
    throw new Error(`unknown provider '${id}' - known providers: ${config.providers.map((p) => p.id).sort().join(", ")}`)
  }
  const { apiKey, warning } = resolveApiKey(settings)
  return {
    settings,
    ...(apiKey === undefined ? {} : { apiKey }),
    warnings: warning === undefined ? [] : [warning],
  }
}

export interface CreateProviderOptions {
  fetchImpl?: typeof fetch
  model?: string
}

export function createProvider(resolved: ResolvedProvider, options: CreateProviderOptions = {}): Provider {
  const { settings } = resolved
  if (settings.id === "fake") return new FakeProvider()

  const perModel = options.model ? settings.models?.[options.model] : undefined
  const capabilities: Partial<ModelCapabilities> = { ...settings.capabilities, ...perModel }

  const common = {
    id: settings.id,
    baseUrl: settings.baseUrl ?? "",
    ...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
    ...(settings.headers === undefined ? {} : { headers: settings.headers }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
  }

  if (settings.dialect === "anthropic") return new AnthropicProvider(common)
  if (!settings.baseUrl) throw new Error(`provider '${settings.id}' has no baseUrl`)
  return new OpenAiCompatibleProvider({ ...common, baseUrl: settings.baseUrl })
}

export function knownProviders(config: ByoaConfig): string[] {
  return config.providers.map((provider) => provider.id).sort()
}
