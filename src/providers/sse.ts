/**
 * Minimal Server-Sent Events reader.
 *
 * Every streaming LLM API in the world is this format plus a JSON dialect, so we own the parser
 * rather than pulling in a dependency. Handles multi-line `data:`, `event:` names, comment lines,
 * and CRLF, which some proxies emit.
 */
export interface SseEvent {
  event?: string
  data: string
}

function parseBlock(block: string): SseEvent | null {
  const dataLines: string[] = []
  let event: string | undefined

  for (const line of block.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const rawValue = colon === -1 ? "" : line.slice(colon + 1)
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue

    if (field === "data") dataLines.push(value)
    else if (field === "event") event = value
  }

  if (dataLines.length === 0) return null
  const data = dataLines.join("\n")
  return event === undefined ? { data } : { event, data }
}

export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ""

  /**
   * The SSE spec allows `\r`, `\n` or `\r\n` as a line terminator, and some proxies emit bare CR.
   * Normalising only `\r\n` left a bare-CR stream unparsed.
   *
   * A trailing `\r` is held back rather than converted: it may be the first half of a CRLF that
   * straddles a chunk boundary, and converting it early invents a frame boundary (`\n` + the next
   * chunk's `\n`).
   */
  const normalise = (text: string, final: boolean): string => {
    const hold = !final && text.endsWith("\r")
    const head = hold ? text.slice(0, -1) : text
    return `${head.replaceAll("\r\n", "\n").replaceAll("\r", "\n")}${hold ? "\r" : ""}`
  }

  for await (const chunk of body) {
    buffer = normalise(buffer + decoder.decode(chunk, { stream: true }), false)

    let boundary = buffer.indexOf("\n\n")
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const parsed = parseBlock(block)
      if (parsed) yield parsed
      boundary = buffer.indexOf("\n\n")
    }
  }

  // The stream is over, so a trailing CR is a terminator after all.
  const tail = parseBlock(normalise(buffer, true))
  if (tail) yield tail
}
