import type { AgentHandle } from "../core/events.ts"

/**
 * A frontend is a dumb terminal: it consumes the event stream and pushes commands back.
 * If an adapter needs to reach into the agent for anything else, the contract is wrong.
 */
export interface FrontendAdapter {
  readonly name: "cli" | "tui" | "web" | "electron"
  start(agent: AgentHandle): Promise<void>
}
