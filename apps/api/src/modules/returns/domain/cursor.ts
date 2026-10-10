/** Opaque keyset cursor: base64url of "<createdAtMs>:<id>". Newest first, ties broken by id. */
export interface Cursor {
  readonly createdAtMs: number;
  readonly id: string;
}

const RE = /^(\d{1,15}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** Largest ms value a JS Date (and thus toISOString) accepts. */
const MAX_DATE_MS = 8.64e15;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdAtMs}:${c.id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor | null {
  if (raw.length > 512) return null;
  const m = RE.exec(Buffer.from(raw, "base64url").toString("utf8"));
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  const ms = Number(m[1]);
  if (!Number.isSafeInteger(ms) || ms > MAX_DATE_MS) return null;
  return { createdAtMs: ms, id: m[2].toLowerCase() };
}
