import { ToolRegistry } from "./registry.ts"
import { readTool } from "./fs-read.ts"
import { writeTool } from "./fs-write.ts"
import { editTool } from "./fs-edit.ts"
import { patchTool } from "./fs-patch.ts"
import { shellTool } from "./shell.ts"
import { recallTool, rememberTool } from "./memory.ts"

/** The v1 toolset. Memory tools read their store from ToolContext at run time. */
export function createDefaultTools(): ToolRegistry {
  return new ToolRegistry()
    .register(shellTool)
    .register(readTool)
    .register(writeTool)
    .register(editTool)
    .register(patchTool)
    .register(recallTool)
    .register(rememberTool)
}
