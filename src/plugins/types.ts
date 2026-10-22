import type { Tool } from "../tools/types.ts"
import type { AgentSpec } from "../agents/types.ts"
import type { McpServerConfig } from "../mcp/types.ts"

/**
 * Handed to a plugin's `activate`. Deliberately tiny: a plugin does not get the agent, the session
 * store, or the config. If it needs something, it contributes a Tool and the ToolContext gives it
 * the workspace, the policy and the abort signal like any built-in tool.
 */
export interface PluginContext {
  /** Absolute path the plugin was imported from. Use it for sibling data files. */
  source: string
  id: string
  /** Warnings land on the harness's stderr, not a raw console.log in the middle of a TUI. */
  log(message: string): void
}

/**
 * What a plugin module's default export must look like.
 *
 * Plugins run IN THIS PROCESS with full Node access. There is no sandbox around plugin code and
 * this file does not pretend otherwise - see README "Plugins are your own code".
 */
export interface PluginManifest {
  /** Unique across all plugins. Used in tool names and in warnings. */
  id: string
  name?: string
  version?: string
  description?: string
  tools?: Tool[]
  agents?: AgentSpec[]
  mcpServers?: McpServerConfig[]
  activate?(context: PluginContext): void | Promise<void>
  deactivate?(context: PluginContext): void | Promise<void>
}

export interface PluginSummary {
  id: string
  name: string
  version: string
  source: string
  tools: number
  agents: number
  mcpServers: number
}

export interface PluginFailure {
  /** The requested id, or the path that was attempted when no candidate resolved. */
  requested: string
  reason: string
}

export interface PluginLoadResult {
  tools: Tool[]
  agents: AgentSpec[]
  mcpServers: McpServerConfig[]
  loaded: PluginSummary[]
  failed: PluginFailure[]
  /** Per-plugin shutdown hooks, already error-trapped. Call these before exit. */
  teardown: Array<() => Promise<void>>
}
