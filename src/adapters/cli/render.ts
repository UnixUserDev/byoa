import type { AgentEvent } from "../../core/events.ts"
import { describePolicy } from "../../sandbox/compile.ts"
import type { SandboxPolicy } from "../../sandbox/policy.ts"

const ESC = "\u001b["

export interface RendererOptions {
  color?: boolean
  out?: { write(chunk: string): unknown }
}

export interface Renderer {
  render(event: AgentEvent): void
  /** Called by the CLI so it can ask a question without the cursor sitting mid-line. */
  endLine(): void
}

export function createRenderer(options: RendererOptions = {}): Renderer {
  const color = options.color ?? true
  const out = options.out ?? process.stdout
  let atLineStart = true
  let turnStartedAt = 0

  const paint = (code: string, text: string): string => (color ? `${ESC}${code}m${text}${ESC}0m` : text)
  const dim = (text: string): string => paint("2", text)
  const red = (text: string): string => paint("31", text)
  const yellow = (text: string): string => paint("33", text)
  const cyan = (text: string): string => paint("36", text)

  const write = (text: string): void => {
    out.write(text)
    atLineStart = text.endsWith("\n")
  }

  const line = (text: string): void => {
    if (!atLineStart) write("\n")
    write(`${text}\n`)
  }

  const summarize = (value: unknown, max = 200): string => {
    let text: string
    try {
      text = typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      text = String(value)
    }
    if (text === undefined) text = String(value)
    return text.length > max ? `${text.slice(0, max)}...` : text
  }

  return {
    endLine(): void {
      if (!atLineStart) write("\n")
    },

    render(event: AgentEvent): void {
      switch (event.t) {
        case "session.info":
          line(dim(`byoa ${event.id} | ${event.provider}/${event.model} | tier ${event.tier} | ${event.cwd}`))
          break
        case "turn.start":
          turnStartedAt = Date.now()
          break
        case "text":
          write(event.delta)
          break
        case "reasoning":
          write(dim(event.delta))
          break
        case "tool.call":
          line(dim(`  -> ${event.name} ${summarize(event.args)}`))
          break
        case "tool.result":
          line(dim(`  <- ${event.name} ${event.ok ? "ok" : "failed"}: ${summarize(event.content, 300)}`))
          break
        case "memory.recall":
          line(dim(`  ~ recalled ${event.hits.length} note(s), ${event.tokens} tokens: ${event.query}`))
          break
        case "memory.write":
          line(dim(`  ~ memory ${event.rejected ? `rejected (${event.rejected})` : "saved"}: ${event.title}`))
          break
        case "sandbox.info":
          line(
            event.degraded
              ? yellow(`  ! ${describePolicy(event.policy)}${event.reason ? ` - ${event.reason}` : ""}`)
              : dim(`  ${describePolicy(event.policy)}`),
          )
          break
        case "approval.request":
          line(yellow(`  ? approval needed: ${event.kind} ${summarize(event.detail)} - /approve or /deny`))
          break
        case "usage":
          // The turn started at turn.start, so the elapsed wall-clock here is a fair measure
          // of how long the model took to produce the output tokens (the tool calls inside the
          // turn are included, which is what the user actually waited for).
          {
            const elapsed = turnStartedAt > 0 ? (Date.now() - turnStartedAt) / 1000 : 0
            const tps = elapsed > 0 ? event.turnOutput / elapsed : 0
            const speed = tps > 0 ? ` @ ${tps.toFixed(1)} tok/s` : ""
            line(
              dim(
                `  tokens: ${event.turnInput} in / ${event.turnOutput} out${speed} (session ${event.sessionInput}/${event.sessionOutput})`,
              ),
            )
          }
          break
        case "turn.end":
          if (!atLineStart) write("\n")
          if (event.finishReason !== "stop") line(dim(`  [${event.finishReason}]`))
          break
        case "error":
          line(red(`error: ${event.message}`))
          break
        default: {
          const never: never = event
          void never
        }
      }
    },
  }
}
