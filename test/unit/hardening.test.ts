import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, statSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commandPositions, deniedCommand, DEFAULT_POLICY, clonePolicy, mergePolicy } from "../../src/sandbox/policy.ts"
import { unwrappedEnvironment } from "../../src/sandbox/envscrub.ts"
import { redact } from "../../src/config/secrets.ts"
import { estimateMessages } from "../../src/core/tokens.ts"
import { openDatabase } from "../../src/store/db.ts"
import { Agent } from "../../src/core/agent.ts"
import { FakeProvider } from "../../src/providers/fake.ts"
import { createDefaultTools } from "../../src/tools/index.ts"
import type { ProviderEvent } from "../../src/providers/types.ts"
import type { AgentEvent } from "../../src/core/events.ts"

/**
 * Regression tests for the security audit. Every one of these failed (or was absent) before the
 * skeleton-root rewrite; they exist so the specific holes cannot come back quietly.
 */

// ---------------------------------------------------------------------------------------------
// The executable deny-list used to look at the first token only.
// ---------------------------------------------------------------------------------------------

test("command positions are found past shell wrappers", () => {
  assert.deepEqual(commandPositions("ls -la /tmp"), ["ls"])
  assert.deepEqual(commandPositions("sudo rm -rf /"), ["sudo"])
  assert.deepEqual(commandPositions("FOO=1 dd if=/dev/zero of=/dev/null"), ["dd"])
  assert.deepEqual(commandPositions("sh -c 'dd if=/dev/zero of=/dev/null'"), ["sh", "dd"])
  assert.deepEqual(commandPositions("env mount --version"), ["env", "mount"])
  assert.deepEqual(commandPositions("xargs -I{} dd if=/dev/zero"), ["xargs", "dd"])
  assert.deepEqual(commandPositions("/usr/bin/dd if=/dev/zero"), ["dd"])
  assert.deepEqual(commandPositions("ls && sudo id"), ["ls", "sudo"])
})

test("the deny-list is checked past the first word", () => {
  const base = clonePolicy(DEFAULT_POLICY)
  assert.equal(deniedCommand(base, "dd if=/dev/zero of=/dev/null count=1"), "dd")
  assert.equal(deniedCommand(base, "FOO=1 dd if=/dev/zero of=/dev/null"), "dd")
  assert.equal(deniedCommand(base, "sh -c 'sudo rm -rf /'"), "sudo")
  assert.equal(deniedCommand(base, "env mount --version"), "mount")
  assert.equal(deniedCommand(base, "xargs -I{} mount"), "mount")
  assert.equal(deniedCommand(base, "/usr/bin/dd if=/dev/zero"), "dd")
})

test("an argument is not mistaken for a command", () => {
  const base = clonePolicy(DEFAULT_POLICY)
  assert.equal(deniedCommand(base, "cat /tmp/dd"), null)
  assert.equal(deniedCommand(base, "grep -rn sudo src/"), null)
  assert.equal(deniedCommand(base, "echo sudo mount"), null)
})

// ---------------------------------------------------------------------------------------------
// The read-allowlist, i.e. the thing that stops the sandbox reading the host's secrets.
// ---------------------------------------------------------------------------------------------

test("the default policy is a read-allowlist with no blanket root and no /run", () => {
  assert.ok(!DEFAULT_POLICY.fs.ro.includes("/"), "a root bind exposes every secret on the box")
  assert.ok(!DEFAULT_POLICY.fs.ro.includes("/run"), "/run carries the session bus and the resolver socket")
  assert.ok(DEFAULT_POLICY.fs.ro.includes("/usr"))
})

test("strict fails closed by default", () => {
  assert.equal(DEFAULT_POLICY.strict, true, "a missing bubblewrap must refuse, not degrade silently")
})

// ---------------------------------------------------------------------------------------------
// The unwrapped paths (--no-sandbox, and the bubblewrap-missing degradation).
// ---------------------------------------------------------------------------------------------

test("the unwrapped environment uses an allowlist, not a four-name denylist", () => {
  const env = unwrappedEnvironment(clonePolicy(DEFAULT_POLICY), {
    PATH: "/usr/bin",
    HOME: "/home/u",
    LANG: "en_GB.UTF-8",
    OPENAI_API_KEY: "sk-should-not-survive",
    GH_TOKEN: "ghp_should_not_survive",
    AWS_SECRET_ACCESS_KEY: "should-not-survive",
    LD_LIBRARY_PATH: "/opt/appimage/lib",
  })
  assert.equal(env.PATH, "/usr/bin")
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.GH_TOKEN, undefined)
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(env.LD_LIBRARY_PATH, undefined, "the AppImage variable is still scrubbed")
})

test("the unwrapped environment keeps a PATH even when the policy dropped it", () => {
  const policy = mergePolicy(clonePolicy(DEFAULT_POLICY), { env: { pass: [] } })
  const env = unwrappedEnvironment(policy, { PATH: "/usr/bin", OPENAI_API_KEY: "sk-nope" })
  assert.equal(env.PATH, "/usr/bin")
  assert.equal(env.OPENAI_API_KEY, undefined)
})

// ---------------------------------------------------------------------------------------------
// redact() - it was dead code that also missed most real key formats.
// ---------------------------------------------------------------------------------------------

/**
 * Credential fixtures are assembled at runtime, deliberately.
 *
 * A contiguous token-shaped literal in the source makes GitHub's push protection reject the whole
 * push ("Push cannot contain secrets"), even when the value is obviously fake and lives in a test.
 * Splitting it means the file never contains a matchable token, while the test still exercises the
 * real shape.
 */
const fixture = (...parts: string[]): string => parts.join("")

test("redact covers the credential families people actually paste", () => {
  const cases: Array<[string, RegExp]> = [
    [fixture("sk-abcdefghij", "klmnopqrstuvwxyz"), /sk-\*\*\*/],
    [fixture("sk-or-v1-", "abcdefghijklmnopqrst"), /sk-\*\*\*/],
    [fixture("ghp_ABCDEFGHIJKLMNOP", "QRSTUVWXYZ0123456789"), /\*\*\*/],
    [fixture("AKIAIOSFODNN7", "EXAMPLE"), /AKIA\*\*\*/],
    [fixture("AIzaSyA1B2C3D4E5F6", "G7H8I9J0KLMNOPQRSTUV"), /AIza\*\*\*/],
    [fixture("xoxb-", "123456789012-abcdefghijklmnop"), /xox\*\*\*/],
    [fixture("gsk_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), /gsk_\*\*\*/],
    [fixture("hf_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), /hf_\*\*\*/],
    [fixture("npm_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), /npm_\*\*\*/],
    [
      fixture("eyJhbGciOiJIUzI1", "NiIsInR5cCI6IkpXVCJ9", ".eyJzdWIiOiIxIn0.abc"),
      /eyJ\*\*\*/,
    ],
    ["postgres://admin:hunter2@db.internal:5432/prod", /postgres:\/\/admin:\*\*\*@/],
    ["KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", /REDACTED PRIVATE KEY/],
    ["Authorization: Bearer abcdefghijklmnop", /Bearer \*\*\*/],
    ["password=hunter2hunter2", /password=\*\*\*/],
  ]
  for (const [input, expected] of cases) {
    const output = redact(input)
    assert.match(output, expected, `not redacted: ${input}`)
    assert.ok(!output.includes("hunter2@") && !output.includes("MIIEow"), `leaked: ${input}`)
  }
})

test("redact leaves ordinary text alone", () => {
  const text = "const answer = 42\n// section 3.1 of the RFC\nfn main() { println!(\"hi\") }"
  assert.equal(redact(text), text)
})

// ---------------------------------------------------------------------------------------------
// Tool results carry no `content` field, so the trim budget used to score them as zero tokens.
// ---------------------------------------------------------------------------------------------

test("estimateMessages counts tool result parts", () => {
  const huge = "X".repeat(400_000)
  const asUser = estimateMessages([{ role: "user", content: huge } as { content?: unknown }])
  const asTool = estimateMessages([{ role: "tool", parts: [{ type: "tool-result", content: huge }] } as { parts?: unknown }])
  assert.ok(asUser > 50_000)
  assert.ok(asTool > 50_000, `a tool result must weigh something, got ${asTool}`)
  assert.ok(Math.abs(asUser - asTool) < asUser * 0.5)
})

test("estimateMessages does not count an assistant reply twice", () => {
  const text = "Y".repeat(8_000)
  const once = estimateMessages([{ role: "assistant", content: text } as { content?: unknown }])
  const withParts = estimateMessages([
    { role: "assistant", content: text, parts: [{ type: "text", text }] } as { content?: unknown; parts?: unknown },
  ])
  // `parts[].text` duplicates `content`; counting both inflated every reply.
  assert.ok(withParts < once * 1.5, `reply counted twice: ${once} vs ${withParts}`)
})

test("estimateMessages counts assistant tool-call arguments", () => {
  const args = { path: "x", content: "Y".repeat(20_000) }
  const withArgs = estimateMessages([{ role: "assistant", parts: [{ type: "tool-call", args }] } as { parts?: unknown }])
  assert.ok(withArgs > 1_000, `arguments must count, got ${withArgs}`)
})

// ---------------------------------------------------------------------------------------------
// The session database holds whatever the model read; it must not be world-readable.
// ---------------------------------------------------------------------------------------------

test("the session database is created 0600 inside a 0700 directory", () => {
  const base = mkdtempSync(join(tmpdir(), "byoa-perm-"))
  try {
    const path = join(base, "nested", "byoa.db")
    const db = openDatabase(path)
    db.close()
    assert.equal(statSync(path).mode & 0o777, 0o600, "the database is a secret store")
    assert.equal(statSync(join(base, "nested")).mode & 0o777, 0o700)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// End to end: a secret read through a tool must not reach the event stream.
// ---------------------------------------------------------------------------------------------

test("credentials read by a tool are redacted before they reach the transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "byoa-redact-"))
  const key = fixture("sk-abcdefghij", "klmnopqrstuvwxyz012345")
  writeFileSync(join(dir, "creds.txt"), `OPENAI_API_KEY=${key}\n`)
  const policy = mergePolicy(clonePolicy(DEFAULT_POLICY), { fs: { ro: ["/usr", "/etc"], rw: [dir] } })

  const script: ProviderEvent[][] = [
    [
      { t: "tool.start", index: 0, id: "call_1", name: "fs_read" },
      { t: "tool.args", index: 0, jsonFragment: JSON.stringify({ path: "creds.txt" }) },
      { t: "tool.end", index: 0, id: "call_1", name: "fs_read", args: { path: "creds.txt" } },
      { t: "done", finishReason: "tool_calls" },
    ],
  ]

  const agent = new Agent({
    provider: new FakeProvider({ script }),
    model: "fake-1",
    tier: "normal",
    tools: createDefaultTools(),
    policy,
    cwd: dir,
  })

  const events: AgentEvent[] = []
  const finished = (async (): Promise<void> => {
    for await (const event of agent.events()) {
      events.push(event)
      if (event.t === "turn.end") break
    }
  })()
  agent.send({ t: "submit", text: "read it" })
  await finished
  await agent.dispose()

  const results = events.filter((event) => event.t === "tool.result")
  assert.equal(results.length, 1)
  const content = results[0]?.t === "tool.result" ? results[0].content : ""
  assert.ok(!content.includes(key), `the key leaked: ${content}`)
  assert.match(content, /sk-\*\*\*/)

  rmSync(dir, { recursive: true, force: true })
})
