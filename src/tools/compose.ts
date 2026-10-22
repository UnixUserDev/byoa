import type { Tool } from "./types.ts"
import type { ToolRegistry } from "./registry.ts"

export interface ExtraTool {
  tool: Tool
  /** Where it came from, for the warning when a name is already taken. */
  source: string
}

/**
 * Register contributed tools onto a base registry.
 *
 * No throw: extensions are already namespaced (`plugin__*`, `mcp__*`) so a collision means two
 * extensions genuinely fought over one name, or one shadowed a builtin. Skipping the newcomer with
 * a line of output is better than refusing to start a session over it.
 */
export function composeTools(
  base: ToolRegistry,
  extra: ExtraTool[],
  log?: (message: string) => void,
): ToolRegistry {
  for (const entry of extra) {
    try {
      base.register(entry.tool)
    } catch (error: unknown) {
      log?.(
        `tool: skipping '${entry.tool.name}' from ${entry.source}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return base
}
