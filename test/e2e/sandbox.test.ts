import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCommand } from "../../src/sandbox/exec.ts"
import { hasBubblewrap, setBubblewrapAvailable } from "../../src/sandbox/detect.ts"
import { clonePolicy, DEFAULT_POLICY, mergePolicy } from "../../src/sandbox/policy.ts"

/**
 * These run the real bubblewrap on this box. They are the only tests that prove isolation actually
 * happens rather than that we generate plausible-looking arguments.
 */
function sandboxRoot(): { workspace: string; outside: string; policy: ReturnType<typeof clonePolicy> } {
  const base = mkdtempSync(join(tmpdir(), "byoa-sbx-"))
  const workspace = join(base, "workspace")
  const outside = join(base, "outside")
  const policy = mergePolicy(clonePolicy(DEFAULT_POLICY), {
    fs: { rw: [workspace], ro: ["/usr", "/etc"], hidden: [], tmpfs: [] },
    env: { pass: ["PATH", "HOME"], scrub: ["LD_LIBRARY_PATH"] },
  })
  return { workspace, outside, policy }
}

async function ensureDirs(workspace: string, outside: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises")
  await mkdir(workspace, { recursive: true })
  await mkdir(outside, { recursive: true })
}

test("a write inside the writable root succeeds", async (t) => {
  if (!hasBubblewrap()) return t.skip("bubblewrap is not available")
  const { workspace, outside, policy } = sandboxRoot()
  await ensureDirs(workspace, outside)

  const result = await runCommand(policy, "echo written > inside.txt && cat inside.txt", { cwd: workspace })
  assert.equal(result.sandboxed, true, "the command should have been sandboxed")
  assert.equal(result.ok, true, result.stderr)
  assert.equal(readFileSync(join(workspace, "inside.txt"), "utf8").trim(), "written")
  assert.ok(!existsSync(join(outside, "inside.txt")))
  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test("a write outside the writable root fails and leaves nothing behind", async (t) => {
  if (!hasBubblewrap()) return t.skip("bubblewrap is not available")
  const { workspace, outside, policy } = sandboxRoot()
  await ensureDirs(workspace, outside)

  // A control write first: without this the assertions below would also hold if bubblewrap failed
  // to start for an unrelated reason, and the test would be green while proving nothing.
  const control = await runCommand(policy, "echo ok > control.txt", { cwd: workspace })
  assert.equal(control.sandboxed, true, "the sandbox must actually be running for this test to mean anything")
  assert.equal(control.ok, true, control.stderr)

  const result = await runCommand(policy, `echo pwned > ${join(outside, "escape.txt")}`, { cwd: workspace })
  assert.equal(result.sandboxed, true)
  assert.notEqual(result.exitCode, 0, "writing to a read-only path must fail")
  assert.equal(existsSync(join(outside, "escape.txt")), false, "the file must not exist on the host")
  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test("the sandbox gets its own network namespace", async (t) => {
  if (!hasBubblewrap()) return t.skip("bubblewrap is not available")
  const { workspace, outside, policy } = sandboxRoot()
  await ensureDirs(workspace, outside)

  // /proc is mounted fresh inside the namespace, so /proc/net/dev reflects the isolated view.
  const result = await runCommand(policy, "cat /proc/net/dev", { cwd: workspace })
  assert.equal(result.ok, true, result.stderr)
  assert.match(result.stdout, /lo:/)
  assert.ok(!/\beth0|\benp|\bwlan/.test(result.stdout), `expected only loopback, got:\n${result.stdout}`)

  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test("the host environment does not leak into the sandbox", async (t) => {
  if (!hasBubblewrap()) return t.skip("bubblewrap is not available")
  const { workspace, outside, policy } = sandboxRoot()
  await ensureDirs(workspace, outside)

  const result = await runCommand(policy, "echo \"[${LEAKED_SECRET:-none}][${HOME}][${LD_LIBRARY_PATH:-clean}]\"", {
    cwd: workspace,
    env: { ...process.env, LEAKED_SECRET: "super-secret-value" },
  })

  assert.match(result.stdout, /\[none\]/, "an unlisted variable must not cross the boundary")
  assert.match(result.stdout, /\[clean\]/, "LD_LIBRARY_PATH must be scrubbed")
  assert.ok(result.stdout.includes(`[${workspace}]`), "HOME should be the workspace")
  assert.ok(!result.stdout.includes("super-secret-value"))

  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test("strict mode refuses to run when bubblewrap is missing", async (t) => {
  if (!hasBubblewrap()) return t.skip("bubblewrap is not available")
  const { workspace, outside, policy } = sandboxRoot()
  await ensureDirs(workspace, outside)

  const strict = mergePolicy(policy, { strict: true })
  setBubblewrapAvailable(false)
  try {
    const result = await runCommand(strict, "echo should-not-run", { cwd: workspace })
    assert.equal(result.ok, false)
    assert.match(result.stderr, /refusing to run/)
    assert.equal(result.stdout, "")
  } finally {
    setBubblewrapAvailable(null)
  }

  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test("a wall-clock timeout kills the command", async (t) => {
  if (!hasBubblewrap()) return t.skip("bubblewrap is not available")
  const { workspace, outside, policy } = sandboxRoot()
  await ensureDirs(workspace, outside)

  const result = await runCommand(policy, "sleep 30", { cwd: workspace, timeoutMs: 500 })
  assert.equal(result.timedOut, true)
  assert.equal(result.ok, false)

  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})
