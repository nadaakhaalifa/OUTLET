import type { CreatorConfig } from "../domain/bridge";

export interface CreatorRuntimeOptions {
  readonly config: CreatorConfig;
  /** ledger bank_settlement account creator payouts leave from. VERIFY (flow of funds, ADR-0003). */
  readonly bankAccount: string;
  /** Public base for affiliate links. */
  readonly linkBase: string;
  /** Server-held secret salt for click device/IP hashes (A-1). Required in production. */
  readonly clickSalt: string;
}

/** Months of affiliate_clicks kept (retention rule affiliate_attribution). */
export const CLICK_RETAIN_MONTHS = 13;
export const CLICK_PARTITIONS_AHEAD = 3;
export const MINUTE_MS = 60_000;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Stable ledger idempotency key of one commission posting intent. */
export const intentKey = (commissionId: string, seq: number): string => `creator_commission:${commissionId}:${seq}`;
export const payoutLedgerKey = (payoutId: string, attempt: number): string => `creator_payout:${payoutId}~${attempt}`;
export const payoutReversalKey = (payoutId: string, attempt: number): string => `creator_payout:${payoutId}~${attempt}:reversal`;

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
/** Unguessable, URL-safe slug from CSPRNG bytes: 16 chars of a 32-symbol alphabet (80 bits). */
export function slugFromBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < 16; i += 1) out += ALPHABET[(bytes[i % bytes.length] ?? 0) % ALPHABET.length] ?? "a";
  return out;
}
