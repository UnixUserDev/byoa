import { test } from "node:test"
import assert from "node:assert/strict"
import { lstatSync } from "node:fs"
import { compileCommand, describePolicy, firstToken } from "../../src/sandbox/compile.ts"
import { clonePolicy, DEFAULT_POLICY, mergePolicy, validatePolicy } from "../../src/sandbox/policy.ts"

const exists = (): boolean => true
const never = (): boolean => false

function policy(patch = {}): ReturnType<typeof clonePolicy> {
  return mergePolicy(clonePolicy(DEFAULT_POLICY), { fs: { rw: ["/work"] }, ...patch })
}

test("firstToken picks the executable out of a compound command", () => {
  assert.equal(firstToken("  ls -la /tmp  "), "ls")
  assert.equal(firstToken("git commit -m 'x'"), "git")
  assert.equal(firstToken(""), "")
})

test("a disabled sandbox runs the command unwrapped and says so", () => {
  const compiled = compileCommand(mergePolicy(policy(), { enabled: false }), {
    cwd: "/work",
    command: "echo hi",
    exists,
  })
  assert.equal(compiled.sandboxed, false)
  assert.deepEqual(compiled.argv, ["/bin/sh", "-c", "echo hi"])
  assert.match(compiled.degradedReason ?? "", /disabled by policy/)
})

test("a denied command never produces an argv at all", () => {
  const compiled = compileCommand(policy(), { cwd: "/work", command: "sudo rm -rf /", exists })
  assert.equal(compiled.argv.length, 0)
  assert.match(compiled.deniedReason ?? "", /denied by sandbox policy/)
})

test("an allowlist makes everything else denied", () => {
  const allowed = mergePolicy(policy(), { commands: { deny: [], allow: ["ls", "cat"] } })
  assert.equal(compileCommand(allowed, { cwd: "/work", command: "ls -la", exists }).deniedReason, undefined)
  assert.match(
    compileCommand(allowed, { cwd: "/work", command: "curl http://x", exists }).deniedReason ?? "",
    /denied/,
  )
})

test("the sandboxed argv carries the pieces that matter", () => {
  const compiled = compileCommand(policy(), { cwd: "/work", command: "echo hi", exists })
  const argv = compiled.argv
  assert.equal(argv[0], "bwrap")
  assert.equal(compiled.sandboxed, true)
  assert.ok(argv.includes("--ro-bind"), "root should be mounted read-only")
  assert.ok(argv.includes("--proc"), "tools read /proc/self")
  assert.ok(argv.includes("--dev"))
  assert.ok(argv.includes("--unshare-all"), "network must be unshared by default")
  assert.ok(argv.includes("--die-with-parent"))
  assert.ok(argv.includes("--new-session"))
  assert.ok(argv.includes("--clearenv"), "environment must not leak into the sandbox")
  assert.deepEqual(argv.slice(-3), ["/bin/sh", "-c", "echo hi"])
})

test("writable roots are bound and the read-only roots are an allowlist, not a blanket root", () => {
  const argv = compileCommand(policy(), { cwd: "/work", command: "ls", exists }).argv
  const bindIndex = argv.indexOf("--bind")
  assert.ok(bindIndex > 0)
  assert.equal(argv[bindIndex + 1], "/work")
  assert.equal(argv[bindIndex + 2], "/work")
  // The whole point of the skeleton root: the host filesystem is never handed over wholesale.
  const blanketRoot = argv.some((arg, index) => argv[index - 1] === "--ro-bind" && arg === "/")
  assert.ok(!blanketRoot, "'--ro-bind / /' would expose every secret on the host")
  assert.ok(argv.includes("/usr"), "the read-only roots are bound one at a time")
})

test("the standard /bin and /lib symlinks are recreated when their target is mounted", () => {
  // A policy that names only /usr is the interesting case: on Arch that would give a root with no
  // /bin at all, which is why the bridge exists. (The default policy names /bin and friends
  // explicitly too, because on Debian they are real directories and cannot be recreated from /usr.)
  const argv = compileCommand(
    mergePolicy(policy(), { fs: { ro: ["/usr", "/etc"], rw: ["/work"], hidden: [], tmpfs: [] } }),
    { cwd: "/work", command: "ls", exists },
  ).argv
  for (const dir of ["/bin", "/sbin", "/lib", "/lib64"]) {
    let isLink = false
    try {
      isLink = lstatSync(dir).isSymbolicLink()
    } catch {
      isLink = false
    }
    if (!isLink) continue
    const found = argv.some((arg, index) => arg === dir && argv[index - 2] === "--symlink")
    assert.ok(found, `${dir} is a symlink on the host but was not recreated inside the sandbox`)
  }
})

test("binds whose destination is missing are dropped instead of failing the run", () => {
  const missing = mergePolicy(policy(), { fs: { rw: ["/work", "/nope"] } })
  const argv = compileCommand(missing, { cwd: "/work", command: "ls", exists: (path) => path !== "/nope" }).argv
  assert.ok(!argv.includes("/nope"), "a non-existent bind destination would abort bubblewrap")
})

test("HOME inside the sandbox is the workspace", () => {
  const argv = compileCommand(policy(), { cwd: "/work", command: "ls", exists, env: {} }).argv
  const index = argv.indexOf("--setenv")
  assert.equal(argv[index + 1], "HOME")
  assert.equal(argv[index + 2], "/work")
})

test("only allowlisted environment variables cross the boundary", () => {
  const argv = compileCommand(policy(), {
    cwd: "/work",
    command: "ls",
    exists,
    env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk-super-secret", LD_LIBRARY_PATH: "/opt/appimage/lib" },
  }).argv

  assert.ok(argv.includes("PATH"))
  assert.ok(!argv.includes("OPENAI_API_KEY"), "API keys must not enter the sandbox")
  assert.ok(!argv.includes("sk-super-secret"))
  assert.ok(!argv.includes("LD_LIBRARY_PATH"), "the AppImage pollutes this variable")
})

test("allow-all exposes the host network, deny does not", () => {
  const denied = compileCommand(policy(), { cwd: "/work", command: "ls", exists }).argv
  assert.ok(!denied.includes("--share-net"))

  const allowed = compileCommand(mergePolicy(policy(), { network: { mode: "allow-all" } }), {
    cwd: "/work",
    command: "ls",
    exists,
  }).argv
  assert.ok(allowed.includes("--share-net"))
})

test("proxy-allowlist is honest about being unimplemented", () => {
  const compiled = compileCommand(
    mergePolicy(policy(), { network: { mode: "proxy-allowlist", proxyUrl: "http://127.0.0.1:8888" } }),
    { cwd: "/work", command: "ls", exists },
  )
  assert.ok(!compiled.argv.includes("--share-net"), "an unimplemented mode must not grant access")
  assert.match(compiled.degradedReason ?? "", /not implemented/)
})

test("hidden paths are shadowed after the writable binds", () => {
  const argv = compileCommand(mergePolicy(policy(), { fs: { rw: ["/work"], hidden: ["/work/.secrets"] } }), {
    cwd: "/work",
    command: "ls",
    exists,
  }).argv
  const bindIndex = argv.indexOf("--bind")
  const tmpfsIndex = argv.indexOf("--tmpfs")
  assert.ok(tmpfsIndex > bindIndex, "shadowing must come after the bind it might otherwise be clobbered by")
})

test("a hidden path that is already invisible is not shadowed", () => {
  // With a skeleton root, $HOME is not mounted, so shadowing ~/.ssh is a no-op - and emitting it
  // risks bubblewrap failing on a destination it cannot create.
  const argv = compileCommand(mergePolicy(policy(), { fs: { rw: ["/work"], hidden: ["/home/u/.ssh"] } }), {
    cwd: "/work",
    command: "ls",
    exists,
  }).argv
  assert.equal(argv.indexOf("--tmpfs"), -1)
})

test("validatePolicy catches the mistakes that would bite at runtime", () => {
  assert.deepEqual(validatePolicy(policy()), [])

  const relative = mergePolicy(policy(), { fs: { rw: ["work"] } })
  assert.match(validatePolicy(relative).join(" "), /absolute/)

  const both = mergePolicy(policy(), { fs: { rw: ["/work"], ro: ["/work"] } })
  assert.match(validatePolicy(both).join(" "), /read-only and read-write/)

  const nested = mergePolicy(policy(), { fs: { rw: ["/work/child"], hidden: ["/work"] } })
  assert.match(validatePolicy(nested).join(" "), /would be mounted over the writable root/)

  // Shadowing a subdirectory of a writable root is the intended use of `hidden`, not a mistake.
  const shadowing = mergePolicy(policy(), { fs: { rw: ["/work"], hidden: ["/work/.secrets"] } })
  assert.deepEqual(validatePolicy(shadowing).filter((problem) => /shadow|mounted over/.test(problem)), [])
})

test("describePolicy reads like something a human can act on", () => {
  assert.match(describePolicy(policy()), /sandbox \| net off/)
  assert.match(describePolicy(mergePolicy(policy(), { enabled: false })), /NO SANDBOX/)
})

test("the exists predicate is the only filesystem dependency", () => {
  const argv = compileCommand(policy(), { cwd: "/work", command: "ls", exists: never }).argv
  assert.ok(!argv.includes("--bind"))
  assert.ok(argv.includes("bwrap"))
})
