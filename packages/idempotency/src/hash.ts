import { createHash } from "node:crypto";

const canonical = (v: unknown): string => {
  if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("requestHash: non-finite number");
    return JSON.stringify(v);
  }
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  throw new TypeError(`requestHash: unsupported value of type ${typeof v}`);
};

/** SHA-256 over key-sorted canonical JSON, so property order does not change the hash. */
export const requestHash = (body: unknown): Uint8Array => new Uint8Array(createHash("sha256").update(canonical(body)).digest());
