import { parseArgs } from "node:util"
import { createInterface } from "node:readline/promises"
import { resolve } from "node:path"
import { Agent } from "../../core/agent.ts"
import { createProvider, resolveProvider } from "../../providers/registry.ts"
import type { ResolvedProvider } from "../../providers/registry.ts"
import { configPath, loadConfig } from "../../config/load.ts"
import { ToolRegistry } from "../../tools/registry.ts"
import { createDefaultTools } from "../../tools/index.ts"
import { composeTools } from "../../tools/compose.ts"
import { assertTierId, isTierId, suggestTier, TIERS } from "../../prompts/tiers.ts"
import type { TierId } from "../../prompts/tiers.ts"
import { clonePolicy, mergePolicy, validatePolicy } from "../../sandbox/policy.ts"
import { hasBubblewrap } from "../../sandbox/detect.ts"
import type { SandboxPolicyPatch } from "../../sandbox/policy.ts"
import { defaultDatabasePath, openDatabase } from "../../store/db.ts"
import { migrate } from "../../store/migrations.ts"
import { SqliteSessionStore } from "../../store/sessions.ts"
import type { SessionRecord } from "../../store/sessions.ts"
import type { ProviderMessage } from "../../providers/types.ts"
import { createMemoryStore } from "../../memory/index.ts"
import type { MemoryStore } from "../../memory/types.ts"
import { createRenderer } from "./render.ts"
import type { Renderer } from "./render.ts"
import { runTui, shouldUseTui } from "../tui/run.ts"
import { broadWorkspaceReason, workspaceProblem } from "./guard.ts"
import { VERSION } from "../../version.ts"
import { redact } from "../../config/secrets.ts"
import { listPluginCandidates, loadPlugins } from "../../plugins/loader.ts"
import type { PluginLoadResult } from "../../plugins/types.ts"
import { McpManager } from "../../mcp/manager.ts"
import { composeMcpServers } from "../../mcp/adapter.ts"
import { SubagentRunner } from "../../agents/runner.ts"
import { createTaskTool } from "../../agents/task-tool.ts"
import type { Tool } from "../../tools/types.ts"

const HELP = `byoa ${VERSION} - bring-your-own-agent

Usage:
  byoa [options] [prompt]
  byoa sessions [--limit <n>] [--match <text>] [--tree] [--db <path>]
  byoa providers [--config <path>]
  byoa plugins [--check] [--config <path>]
  byoa mcp [--config <path>]

Options:
  -p, --prompt <text>     run a single turn and exit
  -P, --provider <id>     provider id (default: fake)
  -m, --model <id>        model id
  -t, --tier <tier>       ${TIERS.join(" | ")} (default: suggested from the model)
  -r, --resume <id>       resume a stored session (id or title substring)
      --cwd <dir>         working directory (default: current directory)
      --net <mode>        deny | allow-all | proxy-allowlist
      --rw <dir>          extra read-write directory (repeatable)
      --no-sandbox        run with no isolation (loudly warned about, never silent)
      --no-strict         degrade instead of refusing when bubblewrap is missing
      --allow-home        permit $HOME (or /home, or /) as the workspace
      --ask               ask before running mutating tools
      --tui               full-screen terminal UI (falls back when not a TTY)
      --no-color          disable ANSI colour
      --db <path>         database path (default: ${defaultDatabasePath()})
      --config <path>     config file (default: ${configPath()})
  -h, --help              show this help
  -v, --version           print the version

Interactive commands:
  /help  /exit  /cancel  /approve  /deny  /tier <tier>  /model <id>  /policy`

const OPTIONS = {
  prompt: { type: "string", short: "p" },
  provider: { type: "string", short: "P" },
  model: { type: "string", short: "m" },
  tier: { type: "string", short: "t" },
  resume: { type: "string", short: "r" },
  cwd: { type: "string" },
  net: { type: "string" },
  rw: { type: "string", multiple: true },
  db: { type: "string" },
  config: { type: "string" },
  limit: { type: "string" },
  match: { type: "string" },
  "no-sandbox": { type: "boolean" },
  "no-strict": { type: "boolean" },
  strict: { type: "boolean" },
  "allow-home": { type: "boolean" },
  tui: { type: "boolean" },
  ask: { type: "boolean" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asBool(value: unknown): boolean {
  return value === true
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function stderr(text: string): void {
  process.stderr.write(`${text}\n`)
}

function stdout(text: string): void {
  process.stdout.write(`${text}\n`)
}

function formatWhen(millis: number): string {
  return new Date(millis).toISOString().replace("T", " ").slice(0, 16)
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "sessions") return listSessions(argv.slice(1))
  if (argv[0] === "providers") return listProviders(argv.slice(1))
  if (argv[0] === "plugins") return listPlugins(argv.slice(1))
  if (argv[0] === "mcp") return listMcp(argv.slice(1))

  let parsed: ReturnType<typeof parseArgs>
  try {
    // No explicit generic: `parseArgs`'s type parameter is the whole config, and our option table
    // contains a `strict` key that collides with its top-level `strict` boolean.
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  } catch (error: unknown) {
    stderr(error instanceof Error ? error.message : String(error))
    return 2
  }

  const { values, positionals } = parsed

  if (asBool(values.help)) {
    stdout(HELP)
    return 0
  }
  if (asBool(values.version)) {
    stdout(VERSION)
    return 0
  }

  const promptArgument = asString(values.prompt)
  if (promptArgument !== undefined && promptArgument.trim().length === 0) {
    // `-p "$VAR"` with an empty variable used to fall through into the REPL and then crash on EOF.
    stderr("-p/--prompt is empty - pass some text, or omit it for the interactive REPL")
    return 2
  }

  const cwd = resolve(asString(values.cwd) ?? process.cwd())
  // Existence and type are always errors; breadth is a warning that needs an explicit opt-in.
  const problem = workspaceProblem(cwd)
  if (problem !== null) {
    stderr(`refusing to use ${cwd} as the workspace: ${problem}`)
    return 2
  }
  if (!asBool(values["allow-home"])) {
    const broad = broadWorkspaceReason(cwd)
    if (broad !== null) {
      stderr(`refusing to use ${cwd} as the workspace: ${broad}. pass --cwd <dir>, or --allow-home to override.`)
      return 2
    }
  }
  const loaded = loadConfig(asString(values.config) ?? configPath())
  for (const warning of loaded.warnings) stderr(`config: ${warning}`)
  const config = loaded.config

  const databasePath =
    asString(values.db) ?? (config.store.path.length > 0 ? config.store.path : defaultDatabasePath())
  let db: ReturnType<typeof openDatabase>
  try {
    db = openDatabase(databasePath)
  } catch (error: unknown) {
    stderr(`could not open database ${databasePath}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  migrate(db)
  const store = new SqliteSessionStore(db)

  // Long-term memory, Obsidian-first. Created once per process and handed to the agent; the store
  // is closeable, so we close it alongside the session store on the way out.
  let memory: MemoryStore | null = null
  try {
    memory = createMemoryStore(config.memory)
  } catch (error: unknown) {
    stderr(`memory: ${error instanceof Error ? error.message : String(error)} - running without memory`)
    memory = null
  }

  // One exit path for everything that owns a resource: MCP children, plugin teardown, the memory
  // store and the session database. Every early return below goes through it.
  let mcp: McpManager | null = null
  const extraTeardown: Array<() => Promise<void>> = []
  const shutdown = async (): Promise<void> => {
    await mcp?.close().catch(() => undefined)
    mcp = null
    for (const hook of extraTeardown.splice(0)) {
      await hook().catch(() => undefined)
    }
    memory?.close()
    store.close()
  }

  // Resolve the session first: when resuming, the stored model, tier and policy are the defaults
  // and only an explicit flag overrides them. Otherwise `--resume` would silently reset you to
  // the fake provider.
  const resumeArgument = asString(values.resume)
  const record = resumeArgument ? findSession(store, resumeArgument) : null
  if (resumeArgument && !record) {
    stderr(`no session matches '${resumeArgument}' - try: byoa sessions`)
    await shutdown()
    return 1
  }

  const providerId = asString(values.provider) ?? record?.provider ?? config.defaults.provider

  let resolved: ResolvedProvider
  try {
    resolved = resolveProvider(config, providerId)
  } catch (error: unknown) {
    stderr(error instanceof Error ? error.message : String(error))
    await shutdown()
    return 2
  }
  for (const warning of resolved.warnings) stderr(`config: ${warning}`)

  const model =
    asString(values.model) ?? record?.model ?? config.defaults.model ?? (providerId === "fake" ? "fake-1" : "")
  if (model.length === 0) {
    stderr(`--model is required when using provider '${providerId}'`)
    await shutdown()
    return 2
  }

  const provider = createProvider(resolved, { model })

  const tierArgument = asString(values.tier)
  const configuredTier = config.defaults.tier === "auto" ? undefined : config.defaults.tier
  const tier: TierId = tierArgument
    ? assertTierId(tierArgument)
    : (record?.tier ?? configuredTier ?? suggestTier(provider.capabilities(model)))

  const policyPatch: SandboxPolicyPatch = {}
  // The workspace goes read-write. Resuming keeps whatever the session was started with, so a
  // session opened with a tighter policy does not get quietly widened - but a *configured* rw list
  // is a deliberate grant and must survive too. `mergePolicy` replaces arrays wholesale, so the
  // base has to be seeded here or the config file is silently ignored.
  const baseRw = record?.policy.fs.rw ?? config.sandbox.fs.rw
  // Relative --rw paths are relative to the session's working directory, not the shell's.
  policyPatch.fs = { rw: [...new Set([cwd, ...baseRw, ...asList(values.rw).map((dir) => resolve(cwd, dir))])] }
  const netMode = asString(values.net)
  if (netMode) policyPatch.network = { mode: netMode as "deny" | "allow-all" | "proxy-allowlist" }
  // Fail closed by default: strict comes from the base policy (true) and only an explicit opt-out
  // turns it off. `--no-sandbox` implies non-strict, because "strict" is meaningless without a
  // sandbox and validatePolicy rejects the combination.
  if (asBool(values["no-sandbox"])) {
    policyPatch.enabled = false
    policyPatch.strict = false
  } else if (asBool(values["no-strict"])) {
    policyPatch.strict = false
  } else if (asBool(values.strict)) {
    policyPatch.strict = true
  }

  const policy = mergePolicy(clonePolicy(record?.policy ?? config.sandbox), policyPatch)
  if (!policy.enabled) {
    stderr("warning: sandbox DISABLED - the model can read and write your real filesystem and environment")
  } else if (!policy.strict && !hasBubblewrap()) {
    stderr("warning: bubblewrap unavailable and strict is off - commands run unwrapped")
  }
  const problems = validatePolicy(policy)
  if (problems.length > 0) {
    for (const problem of problems) stderr(`policy: ${problem}`)
    await shutdown()
    return 2
  }

  const session =
    record ??
    store.create({
      title: undefined,
      provider: providerId,
      model,
      tier,
      cwd,
      policy,
    })
  if (record) store.setModel(session.id, providerId, model, tier)

  const history: ProviderMessage[] = record ? store.getMessages(record.id).map((entry) => entry.message) : []

  // `--ask` needs a human. Over a pipe or in `-p` mode there is nobody to answer, and the approval
  // promise would never settle - so the turn would just hang. Fail safe to auto with a warning
  // rather than deadlock.
  const canAsk = asBool(values.ask) && process.stdin.isTTY === true
  if (asBool(values.ask) && !canAsk) {
    stderr("warning: --ask needs an interactive terminal; running with approvals off")
  }

  // ---- extension layer -----------------------------------------------------
  // Plugins first, because a plugin may contribute MCP servers, and both may contribute tools.
  // Every step here is fail-soft: a broken extension costs its own tools, never the session.
  const pluginResult: PluginLoadResult = await loadPlugins({
    dir: config.plugins.dir,
    enabled: config.plugins.enabled,
    log: (message) => stderr(message),
  })
  extraTeardown.push(...pluginResult.teardown)

  const servers = composeMcpServers(config.mcp.servers, pluginResult.mcpServers)
  if (servers.length > 0) {
    mcp = new McpManager({ servers, log: (message) => stderr(message) })
    await mcp.start()
    const down = mcp.status().filter((status) => !status.ok)
    if (down.length > 0) {
      stderr(`mcp: ${down.length} of ${servers.length} server(s) unavailable - continuing without them`)
    }
    // An MCP server is host-side code. Saying so once is the difference between a boundary and a
    // surprise, because --net deny does not reach it.
    if (policy.network.mode === "deny" && servers.some((server) => server.transport === "http")) {
      stderr("warning: http MCP servers are called from this process, outside the sandbox's network policy")
    }
  }

  const tools = createDefaultTools()
  const addTool = (tool: Tool, source: string): void => {
    composeTools(tools, [{ tool, source }], (message) => stderr(message))
  }
  for (const tool of pluginResult.tools) addTool(tool, "a plugin")
  for (const tool of mcp?.tools() ?? []) addTool(tool, "an MCP server")

  // Lets `/model` and `set.model` switch provider for real, not just relabel the current one.
  const resolveProviderId = (id: string): ReturnType<typeof createProvider> | undefined => {
    try {
      return createProvider(resolveProvider(config, id), { model })
    } catch {
      return undefined
    }
  }

  const runner = new SubagentRunner({
    store,
    provider,
    model,
    tier,
    tools,
    policy,
    cwd,
    approvalMode: canAsk ? "ask" : "auto",
    resolveProvider: resolveProviderId,
  })
  if (config.subagents.enabled) {
    addTool(
      createTaskTool({
        runner,
        presets: pluginResult.agents,
        maxDepth: config.subagents.maxDepth,
        maxSteps: config.subagents.maxSteps,
        ...(config.subagents.maxTokens === undefined ? {} : { maxTokens: config.subagents.maxTokens }),
      }),
      "subagents",
    )
  }

  const agent = new Agent({
    provider,
    model,
    tier,
    tools,
    policy,
    cwd,
    id: session.id,
    title: session.title,
    approvalMode: canAsk ? "ask" : "auto",
    persistence: store.toPersistence(session.id),
    initialHistory: history,
    memory,
    resolveProvider: resolveProviderId,
  })

  const color = !asBool(values["no-color"]) && process.stdout.isTTY === true
  const renderer = createRenderer({ color })

  const promptText = asString(values.prompt) ?? positionals.join(" ").trim()

  const persistModel = (info: { provider: string; model: string; tier: string }): void => {
    try {
      store.setModel(session.id, info.provider, info.model, info.tier as TierId)
    } catch {
      // A session row that vanished under us is not worth crashing the frontend over.
    }
  }

  // TUI: opt-in, and only on a real colour terminal. Any refusal falls back to the plain CLI with
  // one line of explanation rather than a crash.
  if (asBool(values.tui)) {
    const decision = shouldUseTui({
      requested: true,
      stdinTTY: process.stdin.isTTY === true,
      stdoutTTY: process.stdout.isTTY === true,
      ...(process.env.TERM === undefined ? {} : { term: process.env.TERM }),
      noColor: asBool(values["no-color"]) || process.env.NO_COLOR !== undefined,
    })
    if (!decision.ok) {
      stderr(`tui: ${decision.reason} - falling back to the plain CLI`)
    } else {
      try {
        const code = await runTui(agent, {
          ...(promptText.length > 0 ? { prompt: promptText } : {}),
          onSessionChange: persistModel,
        })
        await shutdown()
        return code
      } catch (error: unknown) {
        stderr(
          `tui: ${error instanceof Error ? error.message : String(error)} - falling back to the plain CLI (keep node_modules next to the byoa binary)`,
        )
      }
    }
  }

  if (promptText.length > 0) {
    let finishReason: string = "stop"
    const finished = (async (): Promise<void> => {
      for await (const event of agent.events()) {
        renderer.render(event)
        if (event.t === "turn.end") {
          finishReason = event.finishReason
          break
        }
      }
    })()
    agent.send({ t: "submit", text: promptText })
    await finished
    await agent.dispose()
    await shutdown()
    // A one-shot run is scriptable, so the exit code has to mean something: a failed turn must not
    // look like success to a shell.
    return finishReason === "stop" ? 0 : 1
  }

  // No prompt and no terminal: a REPL here would read EOF immediately and exit 13 with an
  // unsettled-await warning from Node. Refuse with a usage message instead.
  if (process.stdin.isTTY !== true) {
    stderr('stdin is not a terminal - use -p "..." for one-shot mode')
    await shutdown()
    return 2
  }

  const code = await runRepl(agent, renderer, persistModel)
  await shutdown()
  return code
}

function findSession(store: SqliteSessionStore, argument: string): SessionRecord | null {
  const exact = store.get(argument)
  if (exact) return exact
  const matches = store.list({ match: argument, limit: 1 })
  return matches[0] ?? null
}

function sessionLine(record: SessionRecord, indent = 0): string {
  return `${"  ".repeat(indent)}${record.id}  ${formatWhen(record.updatedAt)}  ${record.tier.padEnd(6)}  ${`${record.provider}/${record.model}`.padEnd(28)}  ${record.title}`
}

function listSessions(argv: string[]): number {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        limit: { type: "string" },
        match: { type: "string" },
        db: { type: "string" },
        tree: { type: "boolean" },
      },
      allowPositionals: false,
    })
  } catch (error: unknown) {
    stderr(error instanceof Error ? error.message : String(error))
    return 2
  }
  const limit = Number(asString(parsed.values.limit) ?? "20")
  const databasePath = asString(parsed.values.db) ?? defaultDatabasePath()
  const db = openDatabase(databasePath)
  migrate(db)
  const store = new SqliteSessionStore(db)

  const records = store.list({
    limit: Number.isFinite(limit) ? limit : 20,
    ...(asString(parsed.values.match) ? { match: asString(parsed.values.match) as string } : {}),
  })
  if (records.length === 0) {
    stdout(`no sessions in ${databasePath}`)
    store.close()
    return 0
  }
  if (asBool(parsed.values.tree)) {
    const seen = new Set<string>()
    const print = (record: SessionRecord, depth: number): void => {
      if (seen.has(record.id) || depth > 5) return
      seen.add(record.id)
      stdout(sessionLine(record, depth))
      for (const child of store.listByParent(record.id)) print(child, depth + 1)
    }
    for (const record of records) {
      if (record.parentId !== null && records.some((other) => other.id === record.parentId)) continue
      print(record, 0)
    }
    store.close()
    return 0
  }
  for (const record of records) stdout(sessionLine(record))
  store.close()
  return 0
}

function listProviders(argv: string[]): number {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      options: { config: { type: "string" } },
      allowPositionals: false,
    })
  } catch (error: unknown) {
    stderr(error instanceof Error ? error.message : String(error))
    return 2
  }
  const loaded = loadConfig(asString(parsed.values.config) ?? configPath())
  for (const warning of loaded.warnings) stderr(`config: ${warning}`)

  stdout(`config: ${loaded.path}${loaded.found ? "" : " (not found, using built-in defaults)"}`)
  for (const provider of loaded.config.providers) {
    let key = "-"
    if (provider.apiKeyEnv) {
      const present = (process.env[provider.apiKeyEnv] ?? "").length > 0
      key = `${provider.apiKeyEnv} ${present ? "(set)" : "(unset)"}`
    } else if (provider.apiKey) {
      key = "literal key in config"
    }
    stdout(
      `${provider.id.padEnd(12)} ${provider.dialect.padEnd(9)} ${(provider.baseUrl ?? "-").padEnd(34)} ${key}`,
    )
  }
  return 0
}

async function listPlugins(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      options: { config: { type: "string" }, check: { type: "boolean" } },
      allowPositionals: false,
    })
  } catch (error: unknown) {
    stderr(error instanceof Error ? error.message : String(error))
    return 2
  }

  const loaded = loadConfig(asString(parsed.values.config) ?? configPath())
  for (const warning of loaded.warnings) stderr(`config: ${warning}`)
  const config = loaded.config
  const enabled = new Set(config.plugins.enabled)

  stdout(`config: ${loaded.path}${loaded.found ? "" : " (not found, using built-in defaults)"}`)
  stdout(`dir:    ${config.plugins.dir}`)

  // Listing does not import anything. A plugin is code with your privileges, and `byoa plugins`
  // should not be a command that runs code you just wanted to look at. --check opts in.
  const candidates = listPluginCandidates(config.plugins.dir)
  if (candidates.length === 0) {
    stdout("no plugins found - one .ts/.js file per plugin, or a folder with an index file")
  } else {
    for (const candidate of candidates) {
      stdout(`${enabled.has(candidate.id) ? "[on] " : "[off]"} ${candidate.id.padEnd(24)} ${candidate.path}`)
    }
  }
  for (const id of enabled) {
    if (!candidates.some((candidate) => candidate.id === id)) {
      stderr(`enabled but not found: ${id}`)
    }
  }

  if (!asBool(parsed.values.check)) {
    stdout("")
    stdout("pass --check to import the enabled plugins and report what they contribute")
    return 0
  }

  const result = await loadPlugins({
    dir: config.plugins.dir,
    enabled: config.plugins.enabled,
    log: (message) => stderr(message),
  })
  stdout("")
  for (const summary of result.loaded) {
    stdout(
      `${summary.id.padEnd(20)} v${summary.version.padEnd(8)} tools=${summary.tools} agents=${summary.agents} mcp=${summary.mcpServers}`,
    )
    for (const tool of result.tools.filter((entry) => entry.name.startsWith(`plugin__${summary.id}__`))) {
      stdout(`  ${tool.name.padEnd(34)} ${tool.mutating ? "mutating" : "read-only"}`)
    }
  }
  for (const failure of result.failed) stderr(`failed: ${failure.requested} - ${failure.reason}`)
  for (const hook of result.teardown) await hook()
  return result.failed.length === 0 ? 0 : 1
}

async function listMcp(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      options: { config: { type: "string" }, check: { type: "boolean" } },
      allowPositionals: false,
    })
  } catch (error: unknown) {
    stderr(error instanceof Error ? error.message : String(error))
    return 2
  }

  const loaded = loadConfig(asString(parsed.values.config) ?? configPath())
  for (const warning of loaded.warnings) stderr(`config: ${warning}`)
  const config = loaded.config

  // Plugin-declared servers are not listed until --check, because finding them means importing the
  // plugins. Config-declared ones are always shown.
  const configured = config.mcp.servers
  if (configured.length === 0) {
    stdout("no MCP servers configured (mcp.servers in the config file, or a plugin that declares them)")
  }
  for (const server of configured) {
    const target =
      server.transport === "stdio"
        ? `${server.command ?? "?"} ${(server.args ?? []).join(" ")}`.trim()
        : // A URL may carry `user:password@`; this prints to a terminal and possibly a log.
          redact(server.url ?? "?")
    stdout(`${server.name.padEnd(16)} ${server.transport.padEnd(6)} ${target}`)
  }

  if (!asBool(parsed.values.check)) {
    stdout("")
    stdout("pass --check to start the servers and list the tools they expose")
    return 0
  }

  const pluginResult = await loadPlugins({
    dir: config.plugins.dir,
    enabled: config.plugins.enabled,
    log: (message) => stderr(message),
  })
  const servers = composeMcpServers(configured, pluginResult.mcpServers)
  const manager = new McpManager({ servers, log: (message) => stderr(message) })
  await manager.start()
  stdout("")
  for (const status of manager.status()) {
    stdout(
      `${status.name.padEnd(16)} ${status.ok ? "ok  " : "FAIL"} ${String(status.tools).padStart(3)} tool(s)${status.reason ? `  ${status.reason}` : ""}`,
    )
  }
  for (const tool of manager.tools()) stdout(`  ${tool.name}${tool.mutating ? " (mutating)" : ""}`)
  await manager.close()
  for (const hook of pluginResult.teardown) await hook()
  return manager.status().every((status) => status.ok) ? 0 : 1
}

async function runRepl(
  agent: Agent,
  renderer: Renderer,
  onSessionChange?: (info: { provider: string; model: string; tier: TierId }) => void,
): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let resolveTurn: (() => void) | null = null
  let closed = false
  /**
   * Approvals waiting on this terminal. Without this a `--ask` REPL printed "approval needed" and
   * then waited forever: nothing in the CLI ever sent `approve`, only the TUI did.
   */
  const pending: Array<{ id: string; label: string }> = []

  // `rl.question()` never settles when stdin hits EOF; racing it against close is what stops the
  // process from leaving an unsettled top-level await (which makes Node exit 13).
  let signalClosed: () => void = () => {}
  const closedPromise = new Promise<void>((resolve) => {
    signalClosed = resolve
  })

  /**
   * Settle the turn that is waiting. Written as one function because TS narrowed the inline
   * `const pending = resolveTurn; resolveTurn = null; pending?.()` form to `never` inside a
   * callback, which made the call unrepresentable.
   */
  const finishTurn = (): void => {
    const pending = resolveTurn as (() => void) | null
    resolveTurn = null
    if (pending !== null) pending()
  }

  rl.on("close", () => {
    closed = true
    signalClosed()
    finishTurn()
  })

  rl.on("SIGINT", () => {
    if (resolveTurn) agent.send({ t: "cancel" })
    else rl.close()
  })

  const printer = (async (): Promise<void> => {
    for await (const event of agent.events()) {
      renderer.render(event)
      if (event.t === "session.info") {
        onSessionChange?.({ provider: event.provider, model: event.model, tier: event.tier })
      }
      if (event.t === "approval.request") {
        pending.push({
          id: event.id,
          label: `${event.kind} ${typeof event.detail === "object" && event.detail !== null ? String((event.detail as { name?: unknown }).name ?? "") : ""}`.trim(),
        })
      }
      if (event.t === "turn.end") {
        pending.length = 0
        finishTurn()
      }
    }
  })()

  stdout("type /help for commands, /exit to leave")

  while (!closed) {
    let line: string
    try {
      // Race: whichever happens first, the loop always makes progress and main() always resolves.
      const answer = await Promise.race([rl.question("byoa> "), closedPromise.then(() => null)])
      if (answer === null) break
      line = answer
    } catch {
      break
    }

    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    if (trimmed.startsWith("/")) {
      const [command = "", ...rest] = trimmed.slice(1).split(/\s+/)
      const argument = rest.join(" ")

      if (command === "exit" || command === "quit") break
      if (command === "help") {
        stdout(HELP)
        continue
      }
      if (command === "cancel") {
        agent.send({ t: "cancel" })
        // The agent resolves its own approvals false immediately; clear the mirror so a fast
        // /approve cannot claim to have allowed something that was already cancelled.
        pending.length = 0
        continue
      }
      if (command === "approve" || command === "deny") {
        const target = pending.shift()
        if (!target) {
          stdout("nothing is waiting for approval")
          continue
        }
        agent.send({ t: "approve", id: target.id, allow: command === "approve" })
        stdout(`${command === "approve" ? "allowed" : "denied"}: ${target.label}`)
        continue
      }
      if (command === "tier") {
        if (argument.length === 0) stdout(`tier: ${(await agent.session()).tier}`)
        else if (isTierId(argument)) agent.send({ t: "set.tier", tier: argument })
        else stdout(`unknown tier '${argument}' (expected ${TIERS.join(", ")})`)
        continue
      }
      if (command === "model") {
        if (argument.length === 0) {
          const current = await agent.session()
          stdout(`model: ${current.provider}/${current.model}`)
        } else {
          // `provider/model` switches provider too; a bare name changes the model in place.
          const slash = argument.indexOf("/")
          const session = await agent.session()
          const providerId = slash > 0 ? argument.slice(0, slash) : session.provider
          const modelId = slash > 0 ? argument.slice(slash + 1) : argument
          agent.send({ t: "set.model", provider: providerId, model: modelId })
          stdout(`model: ${providerId}/${modelId}`)
        }
        continue
      }
      if (command === "policy") {
        stdout("policy is set at startup with --net/--rw/--no-sandbox; live tightening lands with the sandbox")
        continue
      }
      stdout(`unknown command: /${command}`)
      continue
    }

    const done = new Promise<void>((resolveDone) => {
      resolveTurn = resolveDone
    })
    agent.send({ t: "submit", text: trimmed })
    await done
  }

  rl.close()
  await agent.dispose()
  await printer
  return 0
}
