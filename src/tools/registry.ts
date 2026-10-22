import type { Tool } from "./types.ts"
import { schemaOf } from "./types.ts"
import type { ToolSchema } from "../providers/types.ts"

export class ToolRegistry {
  #tools = new Map<string, Tool>()

  register(tool: Tool): this {
    if (this.#tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`)
    this.#tools.set(tool.name, tool)
    return this
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name)
  }

  names(): string[] {
    return [...this.#tools.keys()].sort()
  }

  list(): Tool[] {
    return [...this.#tools.values()]
  }

  schemas(): ToolSchema[] {
    return this.list().map(schemaOf)
  }

  /** A restricted copy. Unknown names are ignored, so a preset can name a tool that is absent. */
  pick(names: string[]): ToolRegistry {
    const subset = new ToolRegistry()
    for (const name of names) {
      const tool = this.#tools.get(name)
      if (tool) subset.register(tool)
    }
    return subset
  }

  without(names: string[]): ToolRegistry {
    const drop = new Set(names)
    const subset = new ToolRegistry()
    for (const tool of this.#tools.values()) {
      if (!drop.has(tool.name)) subset.register(tool)
    }
    return subset
  }

  get size(): number {
    return this.#tools.size
  }
}
