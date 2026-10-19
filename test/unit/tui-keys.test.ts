import { test } from "node:test"
import assert from "node:assert/strict"
import { routeKey } from "../../src/adapters/tui/keys.ts"

test("printable keys are never swallowed", () => {
  for (const name of ["a", "z", "1", "space", "question"]) {
    assert.equal(routeKey("idle", { name }).t, "none", name)
  }
})

test("ctrl+c cancels while running and clears while idle", () => {
  assert.equal(routeKey("running", { name: "c", ctrl: true }).t, "cancel")
  assert.equal(routeKey("idle", { name: "c", ctrl: true }).t, "clearInput")
})

test("escape cancels a running turn", () => {
  assert.equal(routeKey("running", { name: "escape" }).t, "cancel")
  assert.equal(routeKey("idle", { name: "escape" }).t, "none")
})

test("approval mode answers with a/d/escape and enter denies by default", () => {
  assert.deepEqual(routeKey("approval", { name: "a" }), { t: "approve", allow: true })
  assert.deepEqual(routeKey("approval", { name: "d" }), { t: "approve", allow: false })
  assert.deepEqual(routeKey("approval", { name: "escape" }), { t: "approve", allow: false })
  assert.deepEqual(routeKey("approval", { name: "enter" }), { t: "approve", allow: false })
})

test("ctrl combinations toggle the panels and scroll", () => {
  assert.equal(routeKey("idle", { name: "t", ctrl: true }).t, "toggleReasoning")
  assert.equal(routeKey("idle", { name: "o", ctrl: true }).t, "toggleTools")
  assert.deepEqual(routeKey("idle", { name: "u", ctrl: true }), { t: "scroll", by: -10 })
  assert.deepEqual(routeKey("idle", { name: "pagedown" }), { t: "scroll", by: 10 })
  assert.equal(routeKey("idle", { name: "end" }).t, "scrollBottom")
})

test("unknown keys do nothing", () => {
  assert.equal(routeKey("idle", { name: "f13" }).t, "none")
})
