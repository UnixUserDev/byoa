import { test } from "node:test"
import assert from "node:assert/strict"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { broadWorkspaceReason } from "../../src/adapters/cli/guard.ts"

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
