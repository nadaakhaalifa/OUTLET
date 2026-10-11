import { DEFAULT_SOCIAL_PROOF, type Drop, type DropState, type SocialProofConfig } from "../domain/bridge";
import type {
  AdmissionVerifierPort,
  Clock,
  DropInventoryPort,
  DropOutboxEvent,
  DropStore,
  IdPort,
  KeysetPosition,
  SocialSignalsPort,
  SoldOutFlagPort,
  SwitchPort,
} from "../domain/ports";

export interface DropsConfig {
  readonly socialProof: SocialProofConfig;
  /** Reservation TTL for drop units (spec 7: 10 min). */
  readonly reservationTtlMs: number;
  /** How long a "sold out" pre-filter hint may live without being refreshed. */
  readonly soldOutHintTtlMs: number;
  /** A queue may open this long before the first admission. */
  readonly preQueueMs: number;
  readonly defaultAdmitPerSec: number;
}

export const DEFAULT_DROPS_CONFIG: DropsConfig = {
  socialProof: DEFAULT_SOCIAL_PROOF,
  reservationTtlMs: 10 * 60_000,
  soldOutHintTtlMs: 30_000,
  preQueueMs: 10 * 60_000,
  defaultAdmitPerSec: 100,
};

export interface DropDeps {
  readonly store: DropStore;
  readonly inventory: DropInventoryPort;
  readonly flags: SoldOutFlagPort;
  readonly signals: SocialSignalsPort;
  readonly switches: SwitchPort;
  readonly verifier: AdmissionVerifierPort;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly cfg: DropsConfig;
}

export const MAX_PAGE = 50;
export const DEFAULT_PAGE = 20;

export const encodeCursor = (p: KeysetPosition): string => Buffer.from(`${p.startsAtMs}:${p.id}`).toString("base64url");
export function decodeCursor(c: string): KeysetPosition | null {
  try {
    const raw = Buffer.from(c, "base64url").toString("utf8");
    const i = raw.indexOf(":");
    const ms = Number(raw.slice(0, i));
    const id = raw.slice(i + 1);
    if (i < 1 || !Number.isSafeInteger(ms) || !/^[0-9a-f-]{36}$/.test(id)) return null;
    return { startsAtMs: ms, id };
  } catch {
    return null;
  }
}

export type Page<T> = { readonly kind: "ok"; readonly items: readonly T[]; readonly nextCursor: string | null } | { readonly kind: "invalid_cursor" };

export async function page(
  cursor: string | null,
  limit: number,
  fetch: (after: KeysetPosition | null, n: number) => Promise<readonly Drop[]>,
): Promise<Page<Drop>> {
  let after: KeysetPosition | null = null;
  if (cursor !== null) {
    after = decodeCursor(cursor);
    if (after === null) return { kind: "invalid_cursor" };
  }
  const size = Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE);
  const rows = await fetch(after, size + 1);
  const items = rows.slice(0, size);
  const last = items[items.length - 1];
  const more = rows.length > size && last !== undefined;
  return { kind: "ok", items, nextCursor: more && last !== undefined ? encodeCursor({ startsAtMs: last.startsAtMs, id: last.id }) : null };
}

export const withState = (d: Drop, state: DropState, nowMs: number): Drop => ({ ...d, state, updatedAtMs: nowMs });

export type { DropOutboxEvent };
