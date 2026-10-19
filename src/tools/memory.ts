import type { Tool, ToolResult, ToolContext } from "./types.ts"
import { argNumber, argString } from "./args.ts"

export const recallTool: Tool = {
  name: "memory_recall",
  description:
    "Search long-term memory (the Obsidian vault) for notes relevant to a query. Returns the most " +
    "relevant hits with snippets, within a token budget. Use before answering when prior context, " +
    "decisions, preferences or project state might matter.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for." },
      limit: { type: "integer", description: "Maximum number of hits (default 5)." },
      tag: { type: "string", description: "Restrict to notes carrying this group tag." },
    },
    required: ["query"],
  },
  async run(args, context): Promise<ToolResult> {
    const store = context.memory
    if (!store) return { ok: false, content: "memory is not configured for this session" }
    const query = argString(args, "query")
    if (!query) return { ok: false, content: "missing required argument: query" }
    const limit = argNumber(args, "limit") ?? 5
    const tag = argString(args, "tag") ?? undefined
    const hits = await store.recall({ query, limit, tag, budgetTokens: 800 })
    if (hits.length === 0) return { ok: true, content: "no memories matched." }
    const lines = hits.map((hit, index) => {
      return `${index + 1}. ${hit.title} [${hit.tag}] (${hit.created})\n   ${hit.snippet}\n   ${hit.path}`
    })
    return { ok: true, content: `recall(${JSON.stringify(query)}) -> ${hits.length} hit(s)\n\n${lines.join("\n\n")}` }
  },
}

export const rememberTool: Tool = {
  name: "memory_remember",
  description:
    "Store a durable memory as a markdown note in the Obsidian vault. One fact per call. The title " +
    "is human-readable (no dates, no hyphen-slugs, never 'Untitled'); the tag is a single group. " +
    "Do not store secrets, credentials, transient chatter, or anything that belongs in AGENTS.md.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The memory to store." },
      title: { type: "string", description: "Short human-readable note title. No dates, no slugs." },
      tag: { type: "string", description: "The note's single group tag (nested paths allowed, e.g. memory/projects)." },
    },
    required: ["text", "title", "tag"],
  },
  async run(args, context): Promise<ToolResult> {
    const store = context.memory
    if (!store) return { ok: false, content: "memory is not configured for this session" }
    const text = argString(args, "text")
    if (text === null) return { ok: false, content: "missing required argument: text" }
    const title = argString(args, "title")
    if (!title) return { ok: false, content: "missing required argument: title" }
    const tag = argString(args, "tag")
    if (!tag) return { ok: false, content: "missing required argument: tag" }

    const result = await store.remember({ text, title, tag, source: "agent" })
    if (result.rejected) {
      context.memory // keep reference
      return { ok: false, content: `rejected: ${result.rejected}` }
    }
    return { ok: true, content: `remembered -> ${result.path}`, meta: { path: result.path, title, tag } }
  },
}
