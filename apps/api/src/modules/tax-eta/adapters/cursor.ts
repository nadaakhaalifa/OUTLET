/** Opaque keyset cursor: base64url of "<createdAtMs>:<id>". Newest first, ties broken by id. */
export interface Cursor {
  readonly createdAtMs: number;
  readonly id: string;
}

const RE = /^(\d{1,15}):([0-9a-f-]{36})$/i;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdAtMs}:${c.id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor | null {
  if (raw.length > 512) return null;
  const m = RE.exec(Buffer.from(raw, "base64url").toString("utf8"));
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  return { createdAtMs: Number(m[1]), id: m[2].toLowerCase() };
}
