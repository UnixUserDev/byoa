import { test } from "node:test"
import assert from "node:assert/strict"

/**
 * The render test is the only one that needs the native FFI, so it is skipped cleanly when
 * @opentui/core is not installed or cannot load (a CLI-only install).
 */
let kit: any = null
let testing: any = null
try {
  kit = await import("@opentui/core")
  testing = await import("@opentui/core/testing")
} catch {
  kit = null
  testing = null
}

const maybe = testing === null ? test.skip : test

maybe("the TUI renders the transcript, tool line and stats", async (t: any) => {
  const { createTestRenderer } = testing
  const { createApp } = await import("../../src/adapters/tui/app.ts")
  const setup = await createTestRenderer({ width: 100, height: 28 })
  try {
    const sent: unknown[] = []
    const agent = {
      events: async function* (): AsyncGenerator<never> {},
      send: (command: unknown) => sent.push(command),
      session: async () => ({ id: "ses_1", title: "demo" }),
      idle: async () => {},
      dispose: async () => {},
    }
    const app = createApp({ agent: agent as never, kit, renderer: setup.renderer, width: 100, height: 28 })
    setup.renderer.root.add(app.root)

    app.handleEvent({
      t: "session.info",
      id: "ses_1",
      title: "demo session",
      provider: "fake",
      model: "fake-1",
      tier: "normal",
      cwd: "/work",
    })
    app.handleEvent({ t: "sandbox.info", applied: true, degraded: false, policy: {} as never })
    app.handleEvent({ t: "turn.start", turn: 1 })
    app.handleEvent({ t: "text", delta: "hello from " })
    app.handleEvent({ t: "text", delta: "the tui" })
    app.handleEvent({ t: "tool.call", id: "c1", name: "fs_read", args: { path: "package.json" }, mutating: false })
    app.handleEvent({ t: "tool.result", id: "c1", name: "fs_read", ok: true, content: "{}" })
    app.handleEvent({ t: "usage", turnInput: 1200, turnOutput: 300, sessionInput: 1200, sessionOutput: 300 })
    app.handleEvent({ t: "turn.end", turn: 1, finishReason: "stop" })

    // Two deltas: the streaming path must render the *second* chunk too. A single-delta test did
    // not catch the append bug (the first chunk arrived through the constructor).
    const frame = await setup.waitForFrame((text: string) => text.includes("hello from the tui"))
    assert.match(frame, /hello from the tui/)
    assert.match(frame, /fs_read/)
    assert.match(frame, /1\.2k in/)
    assert.match(frame, /fake-1/)
    app.dispose()
  } finally {
    await setup.dispose()
  }
})

maybe("an approval bar appears and 'a' sends approve", async () => {
  const { createTestRenderer } = testing
  const { createApp } = await import("../../src/adapters/tui/app.ts")
  const setup = await createTestRenderer({ width: 90, height: 24 })
  try {
    const sent: Array<Record<string, unknown>> = []
    const agent = {
      events: async function* (): AsyncGenerator<never> {},
      send: (command: Record<string, unknown>) => sent.push(command),
      session: async () => ({ id: "ses_1", title: "demo" }),
      idle: async () => {},
      dispose: async () => {},
    }
    const app = createApp({ agent: agent as never, kit, renderer: setup.renderer, width: 90, height: 24 })
    setup.renderer.root.add(app.root)
    app.handleEvent({ t: "turn.start", turn: 1 })
    app.handleEvent({ t: "approval.request", id: "a1", kind: "tool", detail: { name: "fs_write" } })
    const frame = await setup.waitForFrame((text: string) => text.includes("approval needed"))
    assert.match(frame, /a allow/)
    assert.match(frame, /d deny/)

    setup.mockInput.pressKey("a")
    await setup.flush()
    assert.ok(sent.some((command) => command.t === "approve" && command.allow === true), JSON.stringify(sent))
    app.dispose()
  } finally {
    await setup.dispose()
  }
})

maybe("the layout survives a narrow resize", async () => {
  const { createTestRenderer } = testing
  const { createApp } = await import("../../src/adapters/tui/app.ts")
  const setup = await createTestRenderer({ width: 100, height: 28 })
  try {
    const agent = {
      events: async function* (): AsyncGenerator<never> {},
      send: () => {},
      session: async () => ({ id: "x", title: "x" }),
      idle: async () => {},
      dispose: async () => {},
    }
    const app = createApp({ agent: agent as never, kit, renderer: setup.renderer, width: 100, height: 28 })
    setup.renderer.root.add(app.root)
    app.handleEvent({ t: "turn.start", turn: 1 })
    app.handleEvent({ t: "text", delta: "a line that is long enough to need wrapping in a narrow terminal" })
    setup.resize(50, 16)
    await setup.flush()
    const frame = setup.captureCharFrame()
    // No line may exceed the terminal width.
    for (const line of frame.split("\n")) assert.ok(line.length <= 50, `line too long: ${line.length}`)
    app.dispose()
  } finally {
    await setup.dispose()
  }
})
