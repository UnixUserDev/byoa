/**
 * Names that are not up for grabs.
 *
 * A plugin is namespaced (`plugin__<id>__<name>`), so in practice it cannot collide with a builtin -
 * but the check stays, because an MCP server or a future transport may not be namespaced and a
 * silent shadow of `shell` would be the worst kind of bug.
 */
export const RESERVED_TOOL_NAMES: readonly string[] = ["task"]
export const RESERVED_TOOL_PREFIXES: readonly string[] = ["mcp__", "plugin__"]

export function isReservedToolName(name: string): boolean {
  if (RESERVED_TOOL_NAMES.includes(name)) return true
  return RESERVED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** Tool names go into JSON schemas and log lines: keep them boring. */
export function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")
}
