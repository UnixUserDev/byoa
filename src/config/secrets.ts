import type { ProviderSettings } from "./schema.ts"

export interface ResolvedKey {
  apiKey?: string
  warning?: string
}

/**
 * Environment first, literal second. A key sitting in a plaintext config file is allowed because
 * people will do it anyway, but it earns a warning on every run rather than being silently normal.
 */
export function resolveApiKey(settings: ProviderSettings): ResolvedKey {
  if (settings.apiKeyEnv) {
    const value = process.env[settings.apiKeyEnv]
    if (value && value.length > 0) return { apiKey: value }
  }
  if (settings.apiKey && settings.apiKey.length > 0) {
    return {
      apiKey: settings.apiKey,
      warning: `provider '${settings.id}' carries a literal apiKey in config - prefer apiKeyEnv`,
    }
  }
  return {}
}

/**
 * Redact anything that looks like a credential before it reaches a log, an event, a screen or the
 * session database.
 *
 * This is pattern matching, not entropy analysis, so it is a floor and not a ceiling: an unknown
 * format walks through. What it must not do is miss the formats people actually paste into a
 * terminal. Every family below has a test.
 *
 * Absent by design: a bare 40-character AWS secret key. It is indistinguishable from a git SHA or
 * a base64 blob, and a rule loose enough to catch it would censor half of normal output. That one
 * is only caught when it appears next to a name like `secret` or `aws_secret_access_key`.
 */
export function redact(text: string): string {
  return (
    text
      // Multi-line, so it goes first, before the single-token rules chew it up.
      .replace(
        /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/g,
        "-----REDACTED PRIVATE KEY-----",
      )
      // scheme://user:password@host
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^:@/\s]+):[^@/\s]+@/gi, "$1:***@")
      // JWTs and other base64 JSON blobs ({"alg":...} base64-encodes to an eyJ prefix).
      .replace(/\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){0,2}/g, "eyJ***")
      .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, "sk-***")
      .replace(/\b(?:ghp_|gho_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{8,}/g, "***")
      .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "AIza***")
      .replace(/\bxox[baprs]-[0-9A-Za-z-]{10,}/g, "xox***")
      .replace(/\bgsk_[A-Za-z0-9]{16,}/g, "gsk_***")
      .replace(/\bhf_[A-Za-z0-9]{16,}/g, "hf_***")
      .replace(/\bnpm_[A-Za-z0-9]{16,}/g, "npm_***")
      .replace(/\bAKIA[0-9A-Z]{12,}/g, "AKIA***")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***")
      .replace(/((?:authorization|x-api-key|api[_-]?key|password|passwd|secret|token)["'\s:=]+)[^\s"',}]{8,}/gi, "$1***")
  )
}

