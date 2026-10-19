export function asRecord(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {}
}

export function argString(args: unknown, name: string): string | null {
  const value = asRecord(args)[name]
  return typeof value === "string" ? value : null
}

export function argNumber(args: unknown, name: string): number | null {
  const value = asRecord(args)[name]
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function argBool(args: unknown, name: string): boolean {
  const value = asRecord(args)[name]
  return value === true || value === "true"
}
