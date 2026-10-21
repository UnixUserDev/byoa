# Changelog

## 0.2.2 — 2026-10-21

### Hardening

- The workspace guard resolves symlinks, so a link pointing at `$HOME` is refused like `$HOME`.
- `--cwd` must be a directory; a regular file is refused before a session is created.
- The guard message says "its parent directory" rather than `/home`, which is only correct when
  `$HOME` sits directly under `/home`.

### CI

- The agent-loop tests run with `strict` off, so they pass on runners without a usable bubblewrap
  instead of counting the sandbox's fatal startup error as a turn error.
- GitHub Actions bumped to `checkout@v7` / `setup-node@v7`.
- CI builds the release artifacts and checks their version and layout on every push.

## 0.2.1 — 2026-10-19

### Safety

- **`$HOME` is refused as a workspace.** The workspace is the sandbox's single read-write mount,
  so launching from your home directory handed the model everything you own. `$HOME`, its parent
  directory, and `/` are now rejected unless `--allow-home` is passed explicitly. Point the agent
  at a project directory instead.
- A workspace that cannot be created or opened is reported in one line instead of a stack trace.

### Fixed

- A piped/empty stdin no longer leaves an unsettled top-level await (exit 13 with a Node warning);
  the REPL refuses a non-TTY with a usage message.
- `-p ""` is a usage error instead of silently dropping into the REPL.

## 0.2.0 — 2026-10-19

### TUI

- New `--tui` frontend on `@opentui/core`, opt-in and TTY-only, with a clean fallback to the plain
  CLI when stdout is not a terminal, `TERM=dumb`, or `NO_COLOR` is set.
- Calm single-column layout: header, transcript, input, one stats line (tokens in/out, tok/s,
  elapsed, tool calls, memory hits, model/tier/sandbox) and a keybar.
- Incremental streaming (appends, not full repaints), in-place tool-call updates, approval bar
  (`a` allow / `d` deny / `Esc` deny), `Ctrl+T` reasoning, `Ctrl+O` tools, scroll keys.
- Terminal is restored on every exit path, including signals; `renderer.destroy()` is awaited
  before the agent is disposed.
- The TUI and the CLI share the same `AgentEvent`/`AgentCommand` boundary; `run.ts` is the only
  module that loads OpenTUI at runtime.

### Release

- Releases now ship built artifacts (standalone tarball and npm-installable tarball). Node does
  not type-strip TypeScript inside `node_modules`, so the source tree is not an installable
  package; `npm run pack:release` produces both bundles with esbuild.

## 0.1.0 — 2026-10-19

First usable release. CLI only; TUI, Web and Electron adapters are not included.

### Core

- Streaming agent loop with tool calls, cancellation, approvals and a step budget.
- Append-only session store on `node:sqlite` with resume, auto-titling and usage counters.
- Three prompt tiers (`lite` / `normal` / `large`) owning persona, context budget, per-result
  truncation and output cap.
- Provider layer: OpenAI-compatible (including local servers) and Anthropic, with per-model
  capability detection and prompt-cache-aware request assembly.
- Tool set: `shell`, `fs_read`, `fs_write`, `fs_edit`, `fs_patch`.

### Sandbox

- Policy object compiled to a bubblewrap argv; live `set.policy`.
- Skeleton root (no `--ro-bind / /`): only the listed read roots and the workspace exist inside.
- Network denied by default; environment cleared and rebuilt from an allowlist.
- `strict` fails closed when bubblewrap is unusable; the availability probe creates a real
  namespace rather than trusting `bwrap --version`.
- Command deny-list checks command positions past shell wrappers, and is documented as a speed
  bump rather than a boundary.
- `ulimit`-based resource limits; atomic file writes in the fs tools.

### Memory

- Obsidian-backed long-term memory: markdown notes, SQLite FTS5 index, `memory_recall` and
  `memory_remember` tools, tier-budgeted auto-recall.
- Notes are namespaced to `memory/byoa/`, so the harness only reads what it wrote.
- Write gate rejects secrets, empty text and unusable titles.

### Security

- Audit fixes: read-allowlist sandbox, `/run` excluded, env allowlist on unwrapped paths,
  realpath-based path containment, credential redaction at the tool boundary, `0600` session DB.
