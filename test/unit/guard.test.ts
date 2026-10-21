import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { broadWorkspaceReason, workspaceProblem } from "../../src/adapters/cli/guard.ts"

test("the home directory is refused as a workspace", () => {
  assert.match(broadWorkspaceReason(homedir()) ?? "", /home directory/)
})

test("the filesystem root and /home are refused", () => {
  assert.match(broadWorkspaceReason("/") ?? "", /filesystem root/)
  assert.match(broadWorkspaceReason(dirname(homedir())) ?? "", /parent of your home/)
})

test("a project directory is allowed", () => {
  assert.equal(broadWorkspaceReason(join(homedir(), "Projects", "byoa")), null)
  assert.equal(broadWorkspaceReason("/OpenCode-Sandbox/byoa"), null)
  assert.equal(broadWorkspaceReason("/tmp/scratch"), null)
})

test("a path with the home prefix but not the home dir is allowed", () => {
  // `$HOME2` must not be mistaken for `$HOME`.
  assert.equal(broadWorkspaceReason(`${homedir()}2`), null)
})

test("a symlink to the home directory is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "byoa-guard-"))
  try {
    const link = join(dir, "home-link")
    symlinkSync(homedir(), link)
    assert.match(broadWorkspaceReason(link) ?? "", /home directory/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("workspaceProblem rejects missing paths and regular files", () => {
  assert.match(workspaceProblem("/definitely/not/here") ?? "", /does not exist/)
  const dir = mkdtempSync(join(tmpdir(), "byoa-guard-"))
  try {
    const file = join(dir, "a-file")
    writeFileSync(file, "x")
    assert.match(workspaceProblem(file) ?? "", /not a directory/)
    assert.equal(workspaceProblem(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
