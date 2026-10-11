import { uuidv7 } from "../checkout/model";

/** Client-generated UUIDv7 `Idempotency-Key`. Reuse one key across retries of the same attempt. */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues === undefined) throw new Error("no CSPRNG available");
  return uuidv7(Date.now(), c.getRandomValues(new Uint8Array(10)));
}
