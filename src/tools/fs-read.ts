import { open } from "node:fs/promises"
import type { Tool, ToolResult } from "./types.ts"
import { argNumber, argString } from "./args.ts"
import { checkRead, resolvePath } from "./paths.ts"

const DEFAULT_LINE_LIMIT = 2_000
/** Read at most this much into memory. `offset`/`limit` are advertised for large files, but the
 * old code read the whole thing first, so a multi-gigabyte file OOM'd the agent process. */
const MAX_READ_BYTES = 16 * 1024 * 1024

export const readTool: Tool = {
  name: "fs_read",
  description:
    "Read a UTF-8 text file. Returns the raw file contents without line numbers so the exact text " +
    "can be reused as an exact-match anchor. For large files pass offset (1-based line) and limit.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory." },
      offset: { type: "integer", description: "1-based line to start from." },
      limit: { type: "integer", description: "Maximum number of lines to return." },
    },
    required: ["path"],
  },

  async run(args, context): Promise<ToolResult> {
    const input = argString(args, "path")
    if (!input) return { ok: false, content: "missing required argument: path" }

    const path = resolvePath(context.cwd, input)
    const denied = checkRead(context.policy, path)
    if (denied) return { ok: false, content: denied }

    let buffer: Buffer
    let byteCapped = false
    try {
      const handle = await open(path, "r")
      try {
        const stat = await handle.stat()
        if (stat.isDirectory()) return { ok: false, content: `${path} is a directory` }
        const size = Math.min(stat.size, MAX_READ_BYTES)
        byteCapped = stat.size > MAX_READ_BYTES
        const slice = Buffer.alloc(size)
        if (size > 0) await handle.read(slice, 0, size, 0)
        buffer = slice
      } finally {
        await handle.close()
      }
    } catch (error: unknown) {
      const code = (error as { code?: string }).code
      if (code === "ENOENT") return { ok: false, content: `no such file: ${path}` }
      if (code === "EISDIR") return { ok: false, content: `${path} is a directory` }
      return { ok: false, content: `could not read ${path}: ${code ?? String(error)}` }
    }

    // Scan the whole buffer, not a prefix: a NUL that appears after the first 8 KB is exactly what
    // a truncated sniff misses, and it costs one linear pass.
    if (buffer.includes(0)) {
      return { ok: false, content: `${path} looks like a binary file (${buffer.length} bytes)` }
    }

    const text = buffer.toString("utf8")
    const raw = text.split("\n")
    // A trailing newline produces a final empty element; it is not an extra line.
    const lines = raw.length > 1 && raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw
    const offset = Math.max(1, argNumber(args, "offset") ?? 1)
    const limit = Math.max(1, argNumber(args, "limit") ?? DEFAULT_LINE_LIMIT)

    if (offset > lines.length) {
      return {
        ok: false,
        content: `offset ${offset} is past the end of ${path} (${lines.length} line${lines.length === 1 ? "" : "s"})`,
      }
    }

    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const truncated = lines.length > offset - 1 + slice.length
    const notes: string[] = []
    if (truncated) notes.push(`[... ${lines.length - (offset - 1 + slice.length)} more lines]`)
    if (byteCapped) notes.push(`[... file larger than ${MAX_READ_BYTES} bytes; showing the start of it]`)

    const body = [slice.join("\n"), ...notes].filter((part) => part.length > 0).join("\n")
    return {
      ok: true,
      content: body.length > 0 ? body : "(file is empty)",
      meta: { path, lines: lines.length, truncated, byteCapped },
    }
  },
}
