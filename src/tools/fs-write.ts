import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Tool, ToolResult } from "./types.ts"
import { argString } from "./args.ts"
import { checkWrite, resolvePath } from "./paths.ts"
import { sandboxRefusal, writeFileAtomic } from "./fsutil.ts"

export const writeTool: Tool = {
  name: "fs_write",
  description:
    "Write a whole file, creating parent directories as needed. Overwrites any existing content - " +
    "prefer fs_edit or fs_patch when you only mean to change part of a file.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory." },
      content: { type: "string", description: "The complete new file contents." },
    },
    required: ["path", "content"],
  },

  async run(args, context): Promise<ToolResult> {
    const input = argString(args, "path")
    if (!input) return { ok: false, content: "missing required argument: path" }
    const content = argString(args, "content")
    if (content === null) return { ok: false, content: "missing required argument: content" }

    const path = resolvePath(context.cwd, input)
    const denied = checkWrite(context.policy, path)
    if (denied) return { ok: false, content: denied }
    const refusal = sandboxRefusal(context.policy)
    if (refusal) return { ok: false, content: refusal }

    try {
      // Atomic: a crash mid-write must not truncate the file that was already there.
      await writeFileAtomic(path, content)
    } catch (error: unknown) {
      return { ok: false, content: `could not write ${path}: ${String((error as { code?: string }).code ?? error)}` }
    }

    const lines = content.split("\n").length
    return { ok: true, content: `wrote ${content.length} bytes (${lines} lines) to ${path}`, meta: { path, lines } }
  },
}
