/** Spreads an optional string prop only when defined (exactOptionalPropertyTypes-safe). */
export function opt<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: string });
}
