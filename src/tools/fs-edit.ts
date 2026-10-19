import { readFile, writeFile } from "node:fs/promises"
import type { Tool, ToolResult } from "./types.ts"
import { argBool, argString } from "./args.ts"
import { checkWrite, resolvePath } from "./paths.ts"
import { sandboxRefusal, writeFileAtomic } from "./fsutil.ts"

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

export const editTool: Tool = {
  name: "fs_edit",
  description:
    "Replace an exact string in a file. oldString must match the file byte for byte, including " +
    "indentation, and must be unique unless replaceAll is true. Read the file first.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory." },
      oldString: { type: "string", description: "Exact text to replace." },
      newString: { type: "string", description: "Replacement text." },
      replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." },
    },
    required: ["path", "oldString", "newString"],
  },

  async run(args, context): Promise<ToolResult> {
    const input = argString(args, "path")
    if (!input) return { ok: false, content: "missing required argument: path" }
    const oldString = argString(args, "oldString")
    if (oldString === null) return { ok: false, content: "missing required argument: oldString" }
    const newString = argString(args, "newString")
    if (newString === null) return { ok: false, content: "missing required argument: newString" }
    if (oldString === newString) return { ok: false, content: "oldString and newString are identical" }

    const path = resolvePath(context.cwd, input)
    const denied = checkWrite(context.policy, path)
    if (denied) return { ok: false, content: denied }
    const refusal = sandboxRefusal(context.policy)
    if (refusal) return { ok: false, content: refusal }

    let original: string
    try {
      original = await readFile(path, "utf8")
    } catch (error: unknown) {
      const code = (error as { code?: string }).code
      if (code === "ENOENT") return { ok: false, content: `no such file: ${path}` }
      return { ok: false, content: `could not read ${path}: ${code ?? String(error)}` }
    }

    const occurrences = countOccurrences(original, oldString)
    if (occurrences === 0) return { ok: false, content: `oldString not found in ${path} - read the file again` }
    if (occurrences > 1 && !argBool(args, "replaceAll")) {
      return {
        ok: false,
        content: `oldString appears ${occurrences} times in ${path} - include more surrounding context or set replaceAll`,
      }
    }

    const updated = argBool(args, "replaceAll")
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString)

    try {
      await writeFileAtomic(path, updated)
    } catch (error: unknown) {
      return { ok: false, content: `could not write ${path}: ${String((error as { code?: string }).code ?? error)}` }
    }

    return { ok: true, content: `replaced ${occurrences} occurrence(s) in ${path}`, meta: { path, occurrences } }
  },
}
