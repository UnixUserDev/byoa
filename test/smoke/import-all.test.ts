import { test } from "node:test"
import assert from "node:assert/strict"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const SRC = fileURLToPath(new URL("../../src/", import.meta.url))

async function collect(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await collect(full)))
    else if (entry.name.endsWith(".ts")) files.push(full)
  }
  return files
}

/**
 * Native type-stripping is drag-and-drop, but a stray `enum`, `namespace` or constructor
 * parameter property blows up at runtime with no typechecker to catch it. This test imports every
 * module so that trap fails here instead of in the user's terminal.
 */
test("every source module imports under native type-stripping", async () => {
  const files = (await collect(SRC)).sort()
  assert.ok(files.length >= 10, `expected several modules, found ${files.length}`)
  for (const file of files) {
    await import(pathToFileURL(file).href)
  }
})
