import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../src/config/load.ts"
import { redact, resolveApiKey } from "../../src/config/secrets.ts"

function writeConfig(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "byoa-config-"))
  const path = join(dir, "config.json")
  writeFileSync(path, JSON.stringify(contents))
  return path
}

test("a missing config file falls back to the built-in presets", () => {
  const loaded = loadConfig(join(tmpdir(), "definitely-not-here", "config.json"))
  assert.equal(loaded.found, false)
  assert.ok(loaded.config.providers.some((provider) => provider.id === "ollama"))
  assert.ok(loaded.config.providers.some((provider) => provider.id === "anthropic"))
  assert.equal(loaded.config.defaults.provider, "fake")
})

test("a file overrides one field of a preset and inherits the rest", () => {
  const path = writeConfig({ providers: [{ id: "ollama", baseUrl: "http://192.168.1.50:11434/v1" }] })
  const loaded = loadConfig(path)
  const ollama = loaded.config.providers.find((provider) => provider.id === "ollama")
  assert.equal(ollama?.baseUrl, "http://192.168.1.50:11434/v1")
  assert.equal(ollama?.dialect, "openai", "the preset's dialect should survive the merge")
})

test("a file can add a provider that is not a preset", () => {
  const path = writeConfig({
    providers: [{ id: "my-gateway", dialect: "openai", baseUrl: "https://gw.internal/v1", apiKeyEnv: "GW_KEY" }],
  })
  const loaded = loadConfig(path)
  assert.ok(loaded.config.providers.some((provider) => provider.id === "my-gateway"))
})

test("defaults are configurable", () => {
  const path = writeConfig({ defaults: { provider: "ollama", model: "qwen3:8b", tier: "lite" } })
  const loaded = loadConfig(path)
  assert.equal(loaded.config.defaults.provider, "ollama")
  assert.equal(loaded.config.defaults.model, "qwen3:8b")
  assert.equal(loaded.config.defaults.tier, "lite")
})

test("unparseable config warns instead of exploding", () => {
  const dir = mkdtempSync(join(tmpdir(), "byoa-config-"))
  const path = join(dir, "config.json")
  writeFileSync(path, "{ not json")
  const loaded = loadConfig(path)
  assert.equal(loaded.warnings.length, 1)
  assert.match(loaded.warnings[0] ?? "", /could not parse/)
})

test("resolveApiKey prefers the environment over a literal key", () => {
  process.env.BYOA_TEST_KEY = "from-env"
  try {
    const resolved = resolveApiKey({ id: "x", dialect: "openai", apiKeyEnv: "BYOA_TEST_KEY", apiKey: "literal" })
    assert.equal(resolved.apiKey, "from-env")
    assert.equal(resolved.warning, undefined)
  } finally {
    delete process.env.BYOA_TEST_KEY
  }
})

test("a literal key still works but earns a warning", () => {
  const resolved = resolveApiKey({ id: "x", dialect: "openai", apiKey: "sk-literal" })
  assert.equal(resolved.apiKey, "sk-literal")
  assert.match(resolved.warning ?? "", /literal apiKey/)
})

test("an unset environment variable yields no key rather than an empty string", () => {
  const resolved = resolveApiKey({ id: "x", dialect: "openai", apiKeyEnv: "BYOA_DEFINITELY_UNSET" })
  assert.equal(resolved.apiKey, undefined)
})

test("redact scrubs credentials out of text", () => {
  // Split so the file itself never holds a contiguous token literal (GitHub push protection).
  assert.equal(redact(`key ${"sk-abcdefghij" + "klmnopqrst"} done`), "key sk-*** done")
  assert.match(redact("authorization: Bearer abcdefghijklmnop"), /\*\*\*/)
  assert.match(redact("x-api-key: supersecretvalue123"), /\*\*\*/)
  assert.match(redact("token ghp_abcdefghijklmnop"), /\*\*\*/)
})
