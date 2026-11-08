import { Problems } from "./problem.js";

/** Opaque keyset cursor: base64url of `part|part|...` (parts never contain `|`: ISO timestamps and UUIDs). */
export const encodeCursor = (...parts: readonly string[]): string => Buffer.from(parts.join("|"), "utf8").toString("base64url");

export const decodeCursor = (cursor: string, arity: number): string[] => {
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (parts.length !== arity || parts.some((p) => p.length === 0)) throw Problems.badRequest("cursor-invalid");
  return parts;
};
