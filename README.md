# byoa

**B**ring **Y**our **O**wn **A**gent — a local-first coding agent harness.

Point it at any model (OpenAI-compatible, Anthropic, Ollama, llama.cpp, LM Studio, a custom base
URL), pick a prompt tier sized to that model, and let it run shell + file tools inside a
[bubblewrap](https://github.com/containers/bubblewrap) sandbox whose policy you control.

No cloud service. No build step. No runtime dependencies.

## Status

**v0.1.0 — usable, and honest about it.** The core, the provider layer, session persistence, the
tool set, the sandbox and Obsidian-backed memory are implemented and tested. The CLI is the only
frontend that ships today. TUI, Web and Electron adapters are planned but **not** in this release;
neither are MCP, subagents, or web fetch/search.

## Requirements

- **Node.js >= 26** (the code runs directly through native TypeScript type-stripping; there is no
  build step and no transpiler).
- **Linux** with `bubblewrap` for sandboxing (`apt install bubblewrap`, `pacman -S bubblewrap`, …).
  On a machine without it, byoa still runs but commands are unwrapped — and `strict` (the default)
  refuses to run instead of silently degrading.

## Install

```bash
git clone <repo> && cd byoa
npm install          # devDependencies only: typescript + @types/node
node bin/byoa.ts --version
```

Optionally put it on your PATH:

```bash
printf '#!/usr/bin/env bash\nexec node %s/bin/byoa.ts "$@"\n' "$PWD" > ~/.local/bin/byoa
chmod +x ~/.local/bin/byoa
```

## Usage

```bash
# no API key needed: the fake provider echoes and exercises the whole pipeline
node bin/byoa.ts --provider fake -p "hello"

# a real model
node bin/byoa.ts --provider deepseek --model deepseek-chat -p "explain this repo"
node bin/byoa.ts --provider openai --model gpt-4o-mini

# local models (LM Studio / Ollama / llama.cpp all speak the OpenAI protocol)
node bin/byoa.ts --provider lmstudio --model google/gemma-4-e4b
node bin/byoa.ts --provider ollama --model qwen3-coder

# interactive
node bin/byoa.ts
```

Inside the REPL: `/help`, `/tier`, `/model [provider/]model`, `/cancel`, `/exit`.

Sessions are persisted and resumable:

```bash
node bin/byoa.ts sessions
node bin/byoa.ts --resume <id-or-title-substring>
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

## Sandbox

The sandbox is a **policy object first** and a `bwrap` invocation second, so it can be inspected,
printed and tightened. Defaults:

- **Filesystem is a read-allowlist, not a denylist.** Only the roots you list (`/usr`, `/etc`, …)
  plus the workspace are ever mounted. `$HOME`, `/run` and everything else simply do not exist
  inside the namespace. There is no `--ro-bind / /`.
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
