import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listPluginCandidates, loadPlugins, resolvePluginEntry } from "../../src/plugins/loader.ts"

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "byoa-plugins-"))
}

const TOOL = `
const tool = {
  name: "echo",
  description: "echo the text back",
  mutating: false,
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async run(args) {
    return { ok: true, content: String(args.text) }
  },
}
`

test("an enabled plugin contributes a namespaced tool", async () => {
  const dir = await scratch()
  try {
    await writeFile(join(dir, "alpha.ts"), `${TOOL}\nexport default { id: "alpha", tools: [tool] }\n`)
    const result = await loadPlugins({ dir, enabled: ["alpha"], log: () => {} })
    assert.deepEqual(result.loaded.map((entry) => entry.id), ["alpha"])
    assert.deepEqual(result.tools.map((tool) => tool.name), ["plugin__alpha__echo"])
    assert.equal(result.failed.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a plugin that is not enabled is never imported", async () => {
  const dir = await scratch()
  try {
    await writeFile(join(dir, "alpha.ts"), `throw new Error("should not be imported")\n`)
    const result = await loadPlugins({ dir, enabled: [], log: () => {} })
    assert.equal(result.loaded.length, 0)
    assert.equal(result.failed.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a missing plugin is reported and does not abort the rest", async () => {
  const dir = await scratch()
  try {
    await writeFile(join(dir, "alpha.ts"), `${TOOL}\nexport default { id: "alpha", tools: [tool] }\n`)
    const warnings: string[] = []
    const result = await loadPlugins({ dir, enabled: ["ghost", "alpha"], log: (line) => warnings.push(line) })
    assert.deepEqual(result.loaded.map((entry) => entry.id), ["alpha"])
    assert.equal(result.failed[0]?.requested, "ghost")
    assert.match(result.failed[0]?.reason ?? "", /no entry point/)
    assert.ok(warnings.some((line) => line.includes("ghost")))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a plugin that throws on import is skipped without killing the others", async () => {
  const dir = await scratch()
  try {
    await writeFile(join(dir, "broken.ts"), `throw new Error("boom")\n`)
    await writeFile(join(dir, "alpha.ts"), `${TOOL}\nexport default { id: "alpha", tools: [tool] }\n`)
    const result = await loadPlugins({ dir, enabled: ["broken", "alpha"], log: () => {} })
    assert.deepEqual(result.loaded.map((entry) => entry.id), ["alpha"])
    assert.equal(result.failed[0]?.requested, "broken")
    assert.match(result.failed[0]?.reason ?? "", /boom/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a manifest without an id is rejected", async () => {
  const dir = await scratch()
  try {
    await writeFile(join(dir, "anon.ts"), `export default { tools: [] }\n`)
    const result = await loadPlugins({ dir, enabled: ["anon"], log: () => {} })
    assert.equal(result.loaded.length, 0)
    assert.match(result.failed[0]?.reason ?? "", /missing a non-empty 'id'/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("activate() throwing leaves the plugin contributing nothing", async () => {
  const dir = await scratch()
  try {
    await writeFile(
      join(dir, "alpha.ts"),
      `${TOOL}\nexport default { id: "alpha", tools: [tool], activate() { throw new Error("nope") } }\n`,
    )
    const result = await loadPlugins({ dir, enabled: ["alpha"], log: () => {} })
    assert.equal(result.loaded.length, 0)
    assert.equal(result.tools.length, 0)
    assert.match(result.failed[0]?.reason ?? "", /activate\(\) threw: nope/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a malformed tool is dropped but the plugin still loads", async () => {
  const dir = await scratch()
  try {
    await writeFile(
      join(dir, "alpha.ts"),
      `${TOOL}\nexport default { id: "alpha", tools: [{ name: "half", description: "no run" }, tool] }\n`,
    )
    const result = await loadPlugins({ dir, enabled: ["alpha"], log: () => {} })
    assert.deepEqual(result.tools.map((tool) => tool.name), ["plugin__alpha__echo"])
    assert.equal(result.loaded[0]?.tools, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a reserved tool name is refused", async () => {
  const dir = await scratch()
  try {
    await writeFile(
      join(dir, "alpha.ts"),
      `export default { id: "alpha", tools: [{ name: "task", description: "hijack", mutating: false, parameters: {}, async run() { return { ok: true, content: "" } } }] }\n`,
    )
    const result = await loadPlugins({ dir, enabled: ["alpha"], log: () => {} })
    assert.equal(result.tools.length, 0)
    assert.equal(result.loaded[0]?.tools, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a folder plugin resolves through index.ts", async () => {
  const dir = await scratch()
  try {
    const folder = join(dir, "folder-plugin")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "index.ts"), `${TOOL}\nexport default { id: "folder-plugin", tools: [tool] }\n`)
    const entry = resolvePluginEntry(dir, "folder-plugin")
    assert.equal(entry, join(folder, "index.ts"))
    const result = await loadPlugins({ dir, enabled: ["folder-plugin"], log: () => {} })
    assert.deepEqual(result.tools.map((tool) => tool.name), ["plugin__folder-plugin__echo"])
    assert.deepEqual(listPluginCandidates(dir).map((candidate) => candidate.id), ["folder-plugin"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("agents and mcp servers are collected from a plugin", async () => {
  const dir = await scratch()
  try {
    await writeFile(
      join(dir, "alpha.ts"),
      `export default {
  id: "alpha",
  agents: [{ name: "reviewer", prompt: "review things", tools: ["fs_read"] }],
  mcpServers: [{ name: "notes", transport: "stdio", command: "node", args: ["server.js"] }],
}
`,
    )
    const result = await loadPlugins({ dir, enabled: ["alpha"], log: () => {} })
    assert.deepEqual(result.agents.map((spec) => spec.name), ["reviewer"])
    assert.deepEqual(result.mcpServers.map((server) => server.name), ["notes"])
    assert.equal(result.loaded[0]?.agents, 1)
    assert.equal(result.loaded[0]?.mcpServers, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("an invalid mcp server declaration is dropped", async () => {
  const dir = await scratch()
  try {
    await writeFile(
      join(dir, "alpha.ts"),
      `export default { id: "alpha", mcpServers: [{ name: "broken", transport: "carrier-pigeon" }] }\n`,
    )
    const result = await loadPlugins({ dir, enabled: ["alpha"], log: () => {} })
    assert.equal(result.mcpServers.length, 0)
    assert.equal(result.loaded[0]?.mcpServers, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the same plugin listed twice loads once", async () => {
  const dir = await scratch()
  try {
    await writeFile(join(dir, "alpha.ts"), `${TOOL}\nexport default { id: "alpha", tools: [tool] }\n`)
    const result = await loadPlugins({ dir, enabled: ["alpha", "alpha"], log: () => {} })
    assert.equal(result.loaded.length, 1)
    assert.equal(result.tools.length, 1)
    assert.match(result.failed[0]?.reason ?? "", /duplicate plugin id/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("deactivate is registered and runs on teardown", async () => {
  const dir = await scratch()
  try {
    await writeFile(
      join(dir, "alpha.ts"),
      `globalThis.__byoaTornDown = 0
export default { id: "alpha", deactivate() { globalThis.__byoaTornDown = 1 } }
`,
    )
    const result = await loadPlugins({ dir, enabled: ["alpha"], log: () => {} })
    assert.equal(result.teardown.length, 1)
    await result.teardown[0]?.()
    assert.equal((globalThis as Record<string, unknown>).__byoaTornDown, 1)
    delete (globalThis as Record<string, unknown>).__byoaTornDown
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
