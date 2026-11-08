/** Key-sorted, whitespace-free JSON. Throws on non-JSON values so hashes stay stable. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("non-finite number in canonical JSON");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
      const rec = value as Record<string, unknown>;
      const parts = Object.keys(rec)
        .filter((k) => rec[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`);
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`unsupported type in canonical JSON: ${typeof value}`);
  }
}
