# byoa

**B**ring **Y**our **O**wn **A**gent — a local-first coding agent harness.

Point it at any model (OpenAI-compatible, Anthropic, Ollama, llama.cpp, LM Studio, a custom base
URL), pick a prompt tier sized to that model, and let it run shell + file tools inside a
[bubblewrap](https://github.com/containers/bubblewrap) sandbox whose policy you control.

No cloud service. No build step. No required runtime dependencies — the CLI uses Node built-ins
only; the optional TUI uses `@opentui/core`, which ships beside the release binary.

## Status

**v0.3.0 — usable, extensible, and honest about it.** The core, the provider layer, session
persistence, the tool set, the sandbox, Obsidian-backed memory, the terminal UI, an extension layer
(plugins, MCP client, subagents) are implemented and tested. The CLI and the TUI are the frontends
that ship today. Web and Electron adapters are planned but **not** in this release; nor is web
fetch/search.

## Requirements

- **Node.js >= 26** (the code runs directly through native TypeScript type-stripping; there is no
  build step and no transpiler).
- **Linux** with `bubblewrap` for sandboxing (`apt install bubblewrap`, `pacman -S bubblewrap`, …).
  On a machine without it, byoa still runs but commands are unwrapped — and `strict` (the default)
  refuses to run instead of silently degrading.

## Install

Use a release artifact — not the source tree. Node does not type-strip files inside `node_modules`,
so a tarball of the TypeScript source is not a runnable install.

**Standalone** (no npm install; needs Node >= 26):

```bash
mkdir -p ~/.local/lib/byoa ~/.local/bin
tar -xzf byoa-0.3.0-linux-x64.tar.gz -C ~/.local/lib/byoa
ln -sf ~/.local/lib/byoa/byoa ~/.local/bin/byoa
byoa --version
```

Keep the extracted directory together: the launcher resolves `@opentui/core` from the
`node_modules` beside it. Copying the `byoa` file out on its own still runs the plain CLI, but
`--tui` will fall back.

**npm-installable tarball:**

```bash
npm install -g ./byoa-0.3.0-npm.tgz
byoa --version
```

Both are attached to the [releases page](../../releases). `npm run pack:release` rebuilds them
from a checkout.

## Usage

```bash
# no API key needed: the fake provider echoes and exercises the whole pipeline
byoa --provider fake -p "hello"

# a real model
byoa --provider deepseek --model deepseek-chat -p "explain this repo"
byoa --provider openai --model gpt-4o-mini

# local models (LM Studio / Ollama / llama.cpp all speak the OpenAI protocol)
byoa --provider lmstudio --model google/gemma-4-e4b
byoa --provider ollama --model qwen3-coder

# interactive
byoa
byoa --tui
```

Inside the REPL: `/help`, `/tier`, `/model [provider/]model`, `/cancel`, `/exit`.

The TUI (`--tui`) is a calm, single-column layout: header, transcript, input, and one stats line
(tokens in/out, tok/s, elapsed, tool calls, memory hits, model/tier/sandbox). It is opt-in and
falls back to the plain CLI when stdout is not a TTY, `TERM=dumb`, or `NO_COLOR` is set.

TUI keys: `Enter` send · `Ctrl+C` cancel (or clear) · `Esc` cancel · `Ctrl+T` reasoning ·
`Ctrl+O` tools · `PgUp`/`PgDn` scroll · `/help` · `/exit`. Approvals: `a` allow, `d`/`Esc` deny.

Sessions are persisted and resumable:

```bash
byoa sessions
byoa --resume <id-or-title-substring>
```

### Providers

Configured in `~/.config/byoa/config.json` (created on demand; run `byoa providers` to see what is
resolved). Keys are read from environment variables — `openai` uses `OPENAI_API_KEY`, `anthropic`
uses `ANTHROPIC_API_KEY`, and so on. A literal key in the config file is accepted but warns on
every run; prefer `apiKeyEnv`.

Any OpenAI-compatible endpoint works, including a custom base URL and headers.

### Prompt tiers

| Tier | For | History budget | Output cap |
|---|---|---|---|
| `lite` | small/local models | 6k tokens | 2k |
| `normal` | cloud models (default) | 40k tokens | 8k |
| `large` | precision, cost is not the concern | 120k tokens | 16k |

The tier is picked from the model by default (`--tier` overrides). It scales the persona, the
context budget, the per-tool-result ceiling and the output cap as one decision.

## Extensions

Three ways to add capability, all landing in the same tool registry. They share one rule: a broken
extension costs its own tools and nothing else. Startup never dies because of one.

```
byoa plugins            # what is on disk, and what is enabled (imports nothing)
byoa plugins --check    # import them and report what they contribute
byoa mcp                # configured servers (connects to nothing)
byoa mcp --check        # start them and list their tools
byoa sessions --tree    # sessions and the subagent runs they spawned
```

### Plugins

Files in `~/.config/byoa/plugins/`, one `.ts`/`.mts`/`.js`/`.mjs`/`.cjs` per plugin, or a folder with
an `index.*`. TypeScript needs no build step — Node strips the types on import. Listing a plugin in
`plugins.enabled` is what makes it run; dropping a file in the directory does nothing by itself.
An entry may also be a path (`"./scratch/x.ts"`, `/abs/path.ts`) — handy for trying one out before
installing it. The directory is a convention, not a boundary: `enabled` is the boundary.

```ts
export default {
  id: "hello",
  name: "Hello",
  version: "1.0.0",
  tools: [
    {
      name: "shout",
      description: "uppercase the given text",
      mutating: false,
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async run(args) {
        return { ok: true, content: String(args.text).toUpperCase() }
      },
    },
  ],
  agents: [{ name: "greeter", prompt: "You greet people and nothing else." }],
  mcpServers: [{ name: "notes", transport: "stdio", command: "my-mcp-server" }],
  activate(ctx) { ctx.log("ready") },
  deactivate() {},
}
```

Contributed tools are namespaced `plugin__<id>__<tool>`, so they cannot shadow a builtin. `task`,
`mcp__*` and `plugin__*` are reserved.

**Plugins are your own code.** They run in the byoa process with your full privileges — your files,
your environment, your network. There is no sandbox around plugin code and this README will not
pretend otherwise. Enable only plugins you would run as a shell script.

### MCP

Servers are declared in config, or by a plugin (config wins on a name clash, field by field):

```json
{
  "mcp": {
    "servers": [
      { "name": "notes", "transport": "stdio", "command": "npx", "args": ["-y", "@me/notes-mcp"] },
      { "name": "docs", "transport": "http", "url": "https://mcp.example.com/mcp" }
    ]
  }
}
```

- **stdio:** newline-delimited JSON-RPC 2.0. LSP-style `Content-Length:` framing is also accepted,
  because a real share of servers speak it.
- **http:** Streamable HTTP, one POST per message, JSON or SSE replies, `Mcp-Session-Id` carried.
  Server-initiated notifications over a long-lived GET stream are **not** supported.
- Tools appear as `mcp__<server>__<tool>` with the server's own JSON Schema, and default to
  `mutating: true` so `--ask` gates them. `"mutating": false` opts a server out; only do that for a
  server you trust with your files.
- Per-call timeout (`callTimeoutMs`, default 60s) and result cap (`maxResultChars`, default 64KiB).
- The child process gets a scrubbed environment (no inherited API keys) plus whatever `env` names.

**MCP is host-side code.** `--net deny` governs commands run through the sandbox; it does not
govern a stdio server's own syscalls or an HTTP call made from this process. byoa warns when you
configure an HTTP server while the sandbox denies network, because the alternative is implying an
isolation you do not have.

### Subagents

With `subagents.enabled` (the default), the model gets one extra tool: `task`. It delegates a
self-contained job to a child agent with its own context and returns the child's **final answer
only** — the intermediate transcript never enters the parent's context.

```
ceiling: subagents.maxDepth (default 2)   subagents.maxSteps (default 12)
```

- The child is a real session (`byoa sessions --tree` shows the parent link), so its transcript is
  inspectable and resumable.
- A child at the depth ceiling is never offered `task` at all, and the tool refuses before spawning
  anything.
- The child gets no vault memory, and no mutating parent privileges it did not already have: its own
  tools carry their own approval flags, so `--ask` still gates a destructive step.
- Cancelling the parent cancels the child. A token budget (`maxTokens`) can cut a chatty run.
- `task` is `mutating: false` — the delegation itself is not a write; what the child does is.
- Children inherit the provider and model the session started with. `agent` presets (from plugins)
  can override provider, model, tier and tool subset; naming a provider that is not configured is
  an error, not a silent fallback to the parent's.
- Children get no vault memory and no inherited environment, which is a deliberate narrowing of
  what a delegated job can see.

## Sandbox

The sandbox is a **policy object first** and a `bwrap` invocation second, so it can be inspected,
printed and tightened. Defaults:

- **Filesystem is a read-allowlist, not a denylist.** Only the roots you list (`/usr`, `/etc`, …)
  plus the workspace are ever mounted. `$HOME`, `/run` and everything else simply do not exist
  inside the namespace. There is no `--ro-bind / /`.
- **The workspace is the one read-write mount.** Because of that, `$HOME`, its parent directory, and `/` are
  refused as workspaces unless you pass `--allow-home`; point it at a project directory instead.
- **Network is denied** by default (`--unshare-all`). `--net allow-all` shares the host network.
- **Environment is cleared** and rebuilt from an allowlist, so API keys do not cross the boundary.
- **No privilege escalation** (`--unshare-all` implies no-new-privs; `sudo`/`mount` fail).
- **Limits** are applied with `ulimit` inside the spawned shell (bwrap 0.13 has no `--rlimit-*`).

Honest limitations, because a boundary you don't describe is a boundary you don't have:

- The command deny-list is a **speed bump** for destructive commands, not a security boundary. It
  parses shell words and checks command positions; obfuscation can defeat it. The namespace is the
  boundary.
- `--no-sandbox` runs **unsandboxed**, with your environment and your filesystem. It warns loudly,
  and it is not the default. `strict` (default) refuses to run at all when bubblewrap is missing.
- `--net allow-all` exposes the host network, including loopback services.

## Memory

Long-term memory is plain markdown in an Obsidian vault, indexed locally with SQLite FTS5 — no
embeddings, no server, no database to babysit.

- Notes live in `<vault>/memory/byoa/` with YAML frontmatter (`tags`, `created`, `source`) and a
  `[[Inbox]]` footer.
- **Namespaced:** byoa can only read and write its own subfolder, so it never reads notes written
  by another agent or by you. A generic reader with an empty namespace sees the whole vault.
- The model gets two tools: `memory_recall(query, limit?, tag?)` and
  `memory_remember(text, title, tag)`.
- Recalled notes are budgeted per tier and injected as read-only context; lite tier skips
  auto-recall entirely.
- Writes are gated: empty text, unusable titles, or text that looks like it contains credentials
  are rejected with a reason.

`memory.backend: "sqlite"` switches to a plain SQLite store at `~/.local/share/byoa/memory.db`
(no markdown files), with the same namespace behaviour.

## Configuration

`~/.config/byoa/config.json` (or `--config`), `~/.local/share/byoa/byoa.db` for sessions (or
`--db` / `BYOA_DB`), and `BYOA_VAULT` for the Obsidian vault path.

```json
{
  "plugins":   { "dir": "~/.config/byoa/plugins", "enabled": [] },
  "mcp":       { "servers": [] },
  "subagents": { "enabled": true, "maxDepth": 2, "maxSteps": 12, "maxTokens": 4000 }
}
```

Old config files keep working: anything missing falls back to the defaults above, and an empty
`plugins.enabled` means "run no plugin", not "run every plugin".

## Development

```bash
npm test            # tsc --noEmit, then the full suite
npm run test:only   # suite only
npm run smoke       # type-stripping import check
```

The suite includes real bubblewrap isolation tests — they skip only when a working sandbox is
genuinely unavailable, and the probe actually creates a namespace rather than checking
`bwrap --version`.

## License

MIT. See [LICENSE](LICENSE).

---

AI-generated with OpenCode + DeepSeek V4.1 Flash. Human review, testing and direction by the
repository owner.
