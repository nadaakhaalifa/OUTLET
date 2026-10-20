import { uuidv7 } from "../checkout/model";

/** Fresh UUIDv7 for a merge attempt (spec §3). Fails closed when no CSPRNG exists. */
export function newMergeKey(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues === undefined) throw new Error("no CSPRNG available");
  return uuidv7(Date.now(), c.getRandomValues(new Uint8Array(10)));
}
