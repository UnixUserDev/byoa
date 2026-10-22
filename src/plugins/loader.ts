import { readdirSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { AgentSpec } from "../agents/types.ts"
import type { McpServerConfig, McpTransportKind } from "../mcp/types.ts"
import { MCP_TRANSPORTS } from "../mcp/types.ts"
import { isReservedToolName, sanitizeName } from "../tools/names.ts"
import type { Tool } from "../tools/types.ts"
import type {
  PluginContext,
  PluginFailure,
  PluginLoadResult,
  PluginManifest,
  PluginSummary,
} from "./types.ts"

/** Node strips types from `.ts` at import time, so a plugin may be TypeScript with no build step. */
const EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cjs"] as const

export interface LoadPluginsOptions {
  dir: string
  enabled: string[]
  /** Warnings go here. Defaults to writing one line to stderr. */
  log?: (message: string) => void
}

export interface PluginCandidate {
  id: string
  path: string
}

/**
 * Resolve one enablement entry to a file on disk.
 *
 * An entry is either a bare id (`my-plugin` -> `<dir>/my-plugin.ts` or `<dir>/my-plugin/index.ts`)
 * or a path (`./scratch/x.ts`, `/abs/path`), because "trying a plugin out" should not require
 * copying it into the config directory first.
 */
export function resolvePluginEntry(dir: string, requested: string): string | null {
  const looksLikePath = isAbsolute(requested) || requested.startsWith(".") || requested.includes("/")
  const base = looksLikePath ? resolve(dir, requested) : join(dir, requested)

  const direct = candidateFiles(base)
  for (const file of direct) {
    if (isFile(file)) return file
  }
  return null
}

function candidateFiles(base: string): string[] {
  const files: string[] = []
  for (const extension of EXTENSIONS) files.push(`${base}${extension}`)
  // `base` may already carry an extension; try it verbatim too.
  files.unshift(base)
  for (const extension of EXTENSIONS) files.push(join(base, `index${extension}`))
  return files
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Everything that looks loadable in the directory, for `byoa plugins`. */
export function listPluginCandidates(dir: string): PluginCandidate[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const found: PluginCandidate[] = []
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue
    const full = join(dir, entry)
    let isDirectory = false
    try {
      isDirectory = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDirectory) {
      const entrypoint = candidateFiles(full).find((file) => isFile(file) && /(^|\/)index\.[a-z]+$/.test(file))
      if (entrypoint) found.push({ id: entry, path: entrypoint })
      continue
    }
    if (EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      found.push({ id: entry.replace(/\.[^.]+$/, ""), path: full })
    }
  }
  return found
}

/**
 * Load the enabled plugins.
 *
 * Fail-soft is the whole contract: a plugin that cannot be imported, has the wrong shape, throws in
 * `activate`, or declares a tool twice is skipped with a warning. Startup never aborts because of a
 * plugin, and one broken plugin never takes the others with it.
 */
export async function loadPlugins(options: LoadPluginsOptions): Promise<PluginLoadResult> {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`))
  // One absolute directory for every lookup: a relative `plugins.dir` resolved per-entry would
  // depend on whatever cwd the process happened to start in.
  const dir = resolve(options.dir)
  const result: PluginLoadResult = { tools: [], agents: [], mcpServers: [], loaded: [], failed: [], teardown: [] }
  const seenIds = new Set<string>()
  const seenTools = new Set<string>()
  const seenAgents = new Set<string>()

  for (const requested of options.enabled) {
    const trimmed = requested.trim()
    if (trimmed.length === 0) continue

    const path = resolvePluginEntry(dir, trimmed)
    if (!path) {
      result.failed.push({ requested: trimmed, reason: `no entry point in ${dir}` })
      log(`plugin: '${trimmed}' not found in ${dir} - skipped`)
      continue
    }

    let manifest: PluginManifest
    try {
      manifest = await importManifest(path, trimmed)
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      result.failed.push({ requested: trimmed, reason })
      log(`plugin: '${trimmed}' failed to load: ${reason} - skipped`)
      continue
    }

    if (seenIds.has(manifest.id)) {
      const reason = `duplicate plugin id '${manifest.id}'`
      result.failed.push({ requested: trimmed, reason })
      log(`plugin: ${reason} (${path}) - skipped`)
      continue
    }

    const context: PluginContext = {
      source: path,
      id: manifest.id,
      log: (message: string) => log(`plugin ${manifest.id}: ${message}`),
    }

    // Activate before committing anything: a plugin whose activate() throws should contribute
    // nothing, rather than half its tools and then a confusing error.
    if (typeof manifest.activate === "function") {
      try {
        await manifest.activate(context)
      } catch (error: unknown) {
        const reason = `activate() threw: ${error instanceof Error ? error.message : String(error)}`
        result.failed.push({ requested: trimmed, reason })
        log(`plugin: ${reason} (${path}) - skipped`)
        continue
      }
    }

    const namespace = sanitizeName(manifest.id) || "plugin"
    const tools: Tool[] = []
    for (const tool of manifest.tools ?? []) {
      const problem = toolProblem(tool)
      if (problem !== null) {
        log(`plugin ${manifest.id}: ignoring an invalid tool (${problem})`)
        continue
      }
      if (isReservedToolName(tool.name)) {
        log(`plugin ${manifest.id}: ignoring tool '${tool.name}' - the name is reserved`)
        continue
      }
      const leaf = sanitizeName(tool.name)
      if (leaf.length === 0) {
        log(`plugin ${manifest.id}: ignoring tool '${tool.name}' - nothing usable is left after sanitizing the name`)
        continue
      }
      const name = `plugin__${namespace}__${leaf}`
      if (seenTools.has(name)) {
        log(`plugin ${manifest.id}: ignoring duplicate tool '${name}'`)
        continue
      }
      seenTools.add(name)
      tools.push({ ...tool, name, description: tool.description || `plugin ${manifest.id} tool` })
    }

    const agents: AgentSpec[] = []
    for (const spec of manifest.agents ?? []) {
      const problem = agentProblem(spec)
      if (problem !== null) {
        log(`plugin ${manifest.id}: ignoring an invalid agent (${problem})`)
        continue
      }
      if (seenAgents.has(spec.name)) {
        log(`plugin ${manifest.id}: ignoring duplicate agent preset '${spec.name}'`)
        continue
      }
      seenAgents.add(spec.name)
      agents.push(spec)
    }

    const mcpServers: McpServerConfig[] = []
    for (const server of manifest.mcpServers ?? []) {
      const problem = serverProblem(server)
      if (problem !== null) {
        log(`plugin ${manifest.id}: ignoring an invalid mcp server (${problem})`)
        continue
      }
      mcpServers.push(server)
    }

    seenIds.add(manifest.id)
    result.tools.push(...tools)
    result.agents.push(...agents)
    result.mcpServers.push(...mcpServers)
    result.loaded.push(summaryOf(manifest, path, tools, agents, mcpServers))

    if (typeof manifest.deactivate === "function") {
      const deactivate = manifest.deactivate
      result.teardown.push(async () => {
        try {
          await deactivate(context)
        } catch (error: unknown) {
          log(`plugin ${manifest.id}: deactivate() threw: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    }
  }

  return result
}

async function importManifest(path: string, requested: string): Promise<PluginManifest> {
  const module = (await import(pathToFileURL(path).href)) as { default?: unknown }
  const manifest = module.default ?? module
  if (manifest === null || typeof manifest !== "object") {
    throw new Error(`expected a default export object, got ${manifest === null ? "null" : typeof manifest}`)
  }
  const candidate = manifest as PluginManifest
  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
    throw new Error("manifest is missing a non-empty 'id'")
  }
  return candidate
}

function summaryOf(
  manifest: PluginManifest,
  source: string,
  tools: Tool[],
  agents: AgentSpec[],
  mcpServers: McpServerConfig[],
): PluginSummary {
  return {
    id: manifest.id,
    name: manifest.name ?? manifest.id,
    version: manifest.version ?? "-",
    source,
    tools: tools.length,
    agents: agents.length,
    mcpServers: mcpServers.length,
  }
}

function toolProblem(tool: Tool): string | null {
  if (tool === null || typeof tool !== "object") return "not an object"
  if (typeof tool.name !== "string" || tool.name.length === 0) return "name must be a non-empty string"
  if (typeof tool.description !== "string") return "description must be a string"
  if (typeof tool.mutating !== "boolean") return "mutating must be a boolean"
  if (tool.parameters === null || typeof tool.parameters !== "object") return "parameters must be an object"
  if (typeof tool.run !== "function") return "run must be a function"
  if (tool.validate !== undefined && typeof tool.validate !== "function") return "validate must be a function"
  return null
}

function agentProblem(spec: AgentSpec): string | null {
  if (spec === null || typeof spec !== "object") return "not an object"
  if (typeof spec.name !== "string" || spec.name.length === 0) return "name must be a non-empty string"
  if (typeof spec.prompt !== "string" || spec.prompt.length === 0) return "prompt must be a non-empty string"
  if (spec.tools !== undefined && !Array.isArray(spec.tools)) return "tools must be an array of names"
  return null
}

function serverProblem(server: McpServerConfig): string | null {
  if (server === null || typeof server !== "object") return "not an object"
  if (typeof server.name !== "string" || server.name.length === 0) return "name must be a non-empty string"
  if (!MCP_TRANSPORTS.includes(server.transport as McpTransportKind)) {
    return `transport must be one of ${MCP_TRANSPORTS.join(", ")}`
  }
  if (server.transport === "stdio" && typeof server.command !== "string") return "stdio needs a command"
  if (server.transport === "http" && typeof server.url !== "string") return "http needs a url"
  return null
}
