import { readFile, writeFile } from "node:fs/promises"
import type { Tool, ToolResult } from "./types.ts"
import { argString } from "./args.ts"
import { checkWrite, resolvePath } from "./paths.ts"
import { applyPatch } from "./patch.ts"
import { sandboxRefusal, writeFileAtomic } from "./fsutil.ts"

export const patchTool: Tool = {
  name: "fs_patch",
  description:
    "Apply a unified diff to one file. Provide the @@ hunks (the --- and +++ headers are ignored). " +
    "Line numbers may be slightly off: hunks are matched with a couple of lines of fuzz.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory." },
      patch: { type: "string", description: "Unified diff hunks to apply." },
    },
    required: ["path", "patch"],
  },

  async run(args, context): Promise<ToolResult> {
    const input = argString(args, "path")
    if (!input) return { ok: false, content: "missing required argument: path" }
    const patchText = argString(args, "patch")
    if (patchText === null) return { ok: false, content: "missing required argument: patch" }

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

    const applied = applyPatch(original, patchText)
    if (!applied.ok) return { ok: false, content: `${path}: ${applied.error}` }

    try {
      await writeFileAtomic(path, applied.content)
    } catch (error: unknown) {
      return { ok: false, content: `could not write ${path}: ${String((error as { code?: string }).code ?? error)}` }
    }

    return { ok: true, content: `patched ${path}`, meta: { path } }
  },
}
