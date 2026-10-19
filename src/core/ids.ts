import { randomUUID } from "node:crypto"

/**
 * Short, prefixed, lexically-sortable-enough identifiers.
 * Not ULIDs - we only need uniqueness plus a human hint of what the id names.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`
}

export function sessionId(): string {
  return newId("ses")
}

export function messageId(): string {
  return newId("msg")
}
