/**
 * A cheap token estimator. We are not shipping a BPE tokenizer: the budget code only needs
 * to be approximately right and consistently pessimistic, and the real usage numbers that come
 * back from the provider are what we reconcile against.
 *
 * Blend: characters/4 is good for English prose, but code and CJK blow past it, so we take the
 * max of a character estimate and a word-based estimate.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const chars = text.length
  const words = text.split(/\s+/).filter(Boolean).length
  const byChars = Math.ceil(chars / 4)
  const byWords = Math.ceil(words * 1.35)
  // Non-ASCII (CJK, emoji) costs roughly one token per character.
  const nonAscii = (text.match(/[^\u0000-\u007f]/g) ?? []).length
  return Math.max(byChars, byWords, nonAscii) + 1
}

export function estimateMessages(messages: Array<{ content?: unknown; parts?: unknown }>): number {
  let total = 0
  for (const message of messages) {
    const content = message.content
    if (typeof content === "string") total += estimateTokens(content)
    else if (content !== undefined && content !== null) total += estimateTokens(JSON.stringify(content))

    // Tool results carry no `content` field - they live in `parts`. Counting only `content` made
    // every tool result weigh zero against the trim budget, so the history could grow without
    // bound and blow the context window. Assistant tool-call arguments sit here too.
    //
    // `parts[].text` is deliberately NOT counted: an assistant message already carries the same
    // string in `content`, and counting both doubled the estimate for every reply.
    const parts = message.parts
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part === null || typeof part !== "object") continue
        const record = part as { content?: unknown; args?: unknown }
        if (typeof record.content === "string") total += estimateTokens(record.content)
        if (record.args !== undefined) total += estimateTokens(JSON.stringify(record.args))
      }
    }
  }
  return total
}

/**
 * Truncate text to roughly `maxTokens`, cutting on a line boundary when possible so we never
 * hand the model half a line of code.
 */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false }
  const maxChars = Math.max(0, maxTokens * 4)
  const slice = text.slice(0, maxChars)
  const lastNewline = slice.lastIndexOf("\n")
  const cut = lastNewline > maxChars * 0.5 ? slice.slice(0, lastNewline) : slice
  return { text: `${cut}\n[... truncated, ${text.length - cut.length} characters omitted]`, truncated: true }
}
