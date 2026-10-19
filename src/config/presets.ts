import type { ProviderSettings } from "./schema.ts"

/**
 * Built-in provider presets, so `--provider ollama` or `--provider anthropic` works with no config
 * file at all. Anything here can be overridden by adding an entry with the same id to
 * `~/.config/byoa/config.json`.
 */
export const BUILTIN_PROVIDERS: ProviderSettings[] = [
  { id: "fake", dialect: "openai", baseUrl: "http://127.0.0.1:1/v1" },
  { id: "ollama", dialect: "openai", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", dialect: "openai", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "llamacpp", dialect: "openai", baseUrl: "http://127.0.0.1:8080/v1" },
  { id: "vllm", dialect: "openai", baseUrl: "http://127.0.0.1:8000/v1" },
  { id: "openai", dialect: "openai", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
  {
    id: "anthropic",
    dialect: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  {
    id: "openrouter",
    dialect: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  { id: "groq", dialect: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
  { id: "deepseek", dialect: "openai", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
  { id: "together", dialect: "openai", baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY" },
]
