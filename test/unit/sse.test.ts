import { test } from "node:test"
import assert from "node:assert/strict"
import { parseSse } from "../../src/providers/sse.ts"
import type { SseEvent } from "../../src/providers/sse.ts"

/**
 * The reader has to survive the chunk boundaries a real socket produces, not just the tidy
 * `data: {...}\n\n` frames that fixtures usually contain. Every chunk string below is a deliberate
 * split - mid-JSON, between `\r` and `\n`, inside the blank-line separator.
 */
async function read(chunks: string[]): Promise<SseEvent[]> {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  const events: SseEvent[] = []
  for await (const event of parseSse(body)) events.push(event)
  return events
}

test("plain LF frames parse in order", async () => {
  const events = await read(["data: one\n\ndata: two\n\n"])
  assert.deepEqual(events.map((event) => event.data), ["one", "two"])
})

test("a frame split mid-JSON across chunks is reassembled", async () => {
  const events = await read(['data: {"a":', "1}\n\n", "data: [DONE]\n\n"])
  assert.deepEqual(events.map((event) => event.data), ['{"a":1}', "[DONE]"])
})

test("a data line split mid-text across chunks is reassembled", async () => {
  const events = await read(["data: he", "llo\n\n"])
  assert.deepEqual(events.map((event) => event.data), ["hello"])
})

test("a chunk boundary inside the blank-line separator still yields the frame", async () => {
  const events = await read(["data: x\n", "\n"])
  assert.deepEqual(events.map((event) => event.data), ["x"])
})

test("CRLF frames are normalised", async () => {
  const events = await read(["data: one\r\n\r\ndata: two\r\n\r\n"])
  assert.deepEqual(events.map((event) => event.data), ["one", "two"])
})

test("a CRLF pair split between two chunks is still normalised", async () => {
  const events = await read(["data: one\r", "\n\r\ndata: two\r\n\r\n"])
  assert.deepEqual(events.map((event) => event.data), ["one", "two"])
})

test("a stream that ends mid-frame yields the partial tail instead of dropping it", async () => {
  const events = await read(['data: {"partial":'])
  assert.equal(events.length, 1)
  assert.equal(events[0]?.data, '{"partial":')
})

test("an empty body yields nothing", async () => {
  assert.deepEqual(await read([]), [])
})

test("comment lines are ignored and event names are captured", async () => {
  const events = await read([": keep-alive\nevent: chunk\ndata: hello\n\n"])
  assert.equal(events.length, 1)
  assert.equal(events[0]?.event, "chunk")
  assert.equal(events[0]?.data, "hello")
})

test("multiple data lines in one frame are joined with newlines", async () => {
  const events = await read(["data: a\ndata: b\n\n"])
  assert.equal(events[0]?.data, "a\nb")
})

test("a very large fragment survives intact", async () => {
  const payload = "x".repeat(200_000)
  const events = await read([`data: ${payload}\n\n`])
  assert.equal(events.length, 1)
  assert.equal(events[0]?.data.length, payload.length)
})
