import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../../src/adapters/cli/main.ts"

/**
 * The CLI's own shutdown path.
 *
 * These exist because a bug that closed the session database in an unbounded loop passed every
 * unit test in the repo: the components were all fine, and `main()` called itself until the heap
 * died. The only way to catch that is to run `main()`.
 */
async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "byoa-cli-"))
}

async function config(path: string, extra: Record<string, unknown> = {}): Promise<string> {
  await writeFile(
    path,
    JSON.stringify({
      defaults: { provider: "fake", tier: "lite" },
      // Keep the test off the real vault: an in-memory memory store has no side effects.
      memory: { backend: "sqlite", sqlitePath: ":memory:" },
      ...extra,
    }),
  )
  return path
}

test("a one-shot run completes and returns 0", async () => {
  const dir = await scratch()
  try {
    const path = await config(join(dir, "config.json"))
    const code = await main(["-p", "hello", "--config", path, "--db", join(dir, "db.sqlite"), "--no-color"])
    assert.equal(code, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a one-shot run with plugins and an MCP server configured still exits cleanly", async () => {
  const dir = await scratch()
  try {
    const pluginDir = join(dir, "plugins")
    const path = await config(join(dir, "config.json"), {
      plugins: { dir: pluginDir, enabled: ["ghost"] },
      mcp: {
        servers: [
          {
            name: "fake",
            transport: "stdio",
            command: process.execPath,
            args: [join(import.meta.dirname, "..", "fixtures", "fake-mcp-server.mjs")],
          },
        ],
      },
    })
    const code = await main(["-p", "still alive", "--config", path, "--db", join(dir, "db.sqlite"), "--no-color"])
    assert.equal(code, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("an empty -p is a usage error, not a REPL", async () => {
  const dir = await scratch()
  try {
    const path = await config(join(dir, "config.json"))
    const code = await main(["-p", "", "--config", path, "--db", join(dir, "db.sqlite")])
    assert.equal(code, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("subagents can be switched off in config", async () => {
  const dir = await scratch()
  try {
    const path = await config(join(dir, "config.json"), { subagents: { enabled: false } })
    const code = await main(["-p", "no delegation", "--config", path, "--db", join(dir, "db.sqlite"), "--no-color"])
    assert.equal(code, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
