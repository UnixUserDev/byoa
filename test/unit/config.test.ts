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

test("the extension sections default to off and empty", () => {
  const loaded = loadConfig(join(tmpdir(), "definitely-not-here", "config2.json"))
  assert.deepEqual(loaded.config.plugins.enabled, [], "no plugin runs unless it is named")
  assert.equal(loaded.config.plugins.dir.endsWith("byoa/plugins"), true)
  assert.deepEqual(loaded.config.mcp.servers, [])
  assert.deepEqual(loaded.config.subagents, { enabled: true, maxDepth: 2, maxSteps: 12 })
})

test("an old config file without the extension keys still loads", () => {
  const path = writeConfig({ defaults: { provider: "ollama", tier: "normal" } })
  const loaded = loadConfig(path)
  assert.equal(loaded.config.defaults.provider, "ollama")
  assert.deepEqual(loaded.config.plugins.enabled, [])
  assert.equal(loaded.config.subagents.enabled, true)
})

test("plugins.enabled keeps only usable ids", () => {
  const path = writeConfig({ plugins: { enabled: ["alpha", "", 42, null, "beta"] } })
  const loaded = loadConfig(path)
  assert.deepEqual(loaded.config.plugins.enabled, ["alpha", "beta"])
})

test("a plugin directory can be relocated", () => {
  const path = writeConfig({ plugins: { dir: "/srv/byoa/plugins", enabled: ["x"] } })
  const loaded = loadConfig(path)
  assert.equal(loaded.config.plugins.dir, "/srv/byoa/plugins")
  assert.deepEqual(loaded.config.plugins.enabled, ["x"])
})

test("mcp servers are read, and an unnamed one is dropped with a warning", () => {
  const path = writeConfig({
    mcp: {
      servers: [
        { name: "notes", transport: "stdio", command: "node", args: ["server.js"] },
        { transport: "http", url: "http://localhost:1/mcp" },
      ],
    },
  })
  const loaded = loadConfig(path)
  assert.deepEqual(loaded.config.mcp.servers.map((server) => server.name), ["notes"])
  assert.ok(loaded.warnings.some((warning) => warning.includes("mcp: ignoring a server entry with no name")))
})

test("subagent limits can be tightened in config", () => {
  const path = writeConfig({ subagents: { enabled: false, maxDepth: 0, maxSteps: 3 } })
  const loaded = loadConfig(path)
  assert.equal(loaded.config.subagents.enabled, false)
  assert.equal(loaded.config.subagents.maxDepth, 0)
  assert.equal(loaded.config.subagents.maxSteps, 3)
})

test("numeric ceilings are clamped, because JSON is not typed", () => {
  const path = writeConfig({ subagents: { maxDepth: "many", maxSteps: 0, maxTokens: -5 } })
  const loaded = loadConfig(path)
  // A NaN comparison would silently remove the ceiling instead of tightening it.
  assert.equal(loaded.config.subagents.maxDepth, 2, "an unusable depth falls back to the default")
  assert.equal(loaded.config.subagents.maxSteps, 1, "a step cap of zero would stall every child")
  assert.equal(loaded.config.subagents.maxTokens, undefined, "a negative budget means no budget")
})

test("a reasonable token ceiling survives", () => {
  const path = writeConfig({ subagents: { maxTokens: 4000 } })
  assert.equal(loadConfig(path).config.subagents.maxTokens, 4000)
})

test("a null ceiling falls back instead of becoming zero", () => {
  const path = writeConfig({ subagents: { maxDepth: null, maxSteps: "", maxTokens: null } })
  const loaded = loadConfig(path)
  // Number(null) is 0, which would have silently meant "no delegation at all" and "one step".
  assert.equal(loaded.config.subagents.maxDepth, 2)
  assert.equal(loaded.config.subagents.maxSteps, 12)
  assert.equal(loaded.config.subagents.maxTokens, undefined)
})
