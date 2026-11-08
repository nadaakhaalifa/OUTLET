import { createHash } from "node:crypto";

export class InvalidCursorError extends Error {
  constructor() {
    super("invalid search cursor");
  }
}

export interface KeysetPosition {
  readonly rank: number;
  readonly id: string;
  /** Relaxation steps already applied on page 1, replayed so later pages continue the same result set. */
  readonly relaxed: readonly string[];
}

/** Fingerprint of everything that changes the result set, so a cursor cannot be replayed against a different query. */
export const fingerprint = (parts: unknown): string => createHash("sha256").update(JSON.stringify(parts, (_k, v: unknown) => (typeof v === "bigint" ? `${v.toString()}n` : v))).digest("hex").slice(0, 16);

export const encodeCursor = (pos: KeysetPosition, fp: string): string => Buffer.from(JSON.stringify({ r: pos.rank, i: pos.id, f: fp, x: pos.relaxed })).toString("base64url");

export const decodeCursor = (cursor: string, fp: string): KeysetPosition => {
  try {
    const o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { r?: unknown; i?: unknown; f?: unknown; x?: unknown };
    if (typeof o.r !== "number" || !Number.isFinite(o.r) || typeof o.i !== "string" || !/^[0-9a-f-]{36}$/.test(o.i) || o.f !== fp || !Array.isArray(o.x) || !o.x.every((v) => typeof v === "string")) throw new InvalidCursorError();
    return { rank: o.r, id: o.i, relaxed: o.x };
  } catch {
    throw new InvalidCursorError();
  }
};
