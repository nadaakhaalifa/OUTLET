import type { Queryable, SqlClient } from "@outlet/db";
import { money } from "@outlet/money";
import { accountCode } from "../src/index.js";
import type { AccountType, JournalEntryDraft } from "../src/index.js";

export const MARKET = "EG";
const OCCURRED = new Date("2026-11-08T10:00:00.000Z");

/** Full account code in market EG / EGP. */
export const acc = (type: AccountType, owner?: string, sub?: string): string =>
  accountCode({ type, market: MARKET, currency: "EGP", ...(owner !== undefined ? { owner } : {}), ...(sub !== undefined ? { sub } : {}) });

export type Line = readonly [code: string, amount: bigint];
/** Debit (positive). */
export const dr = (code: string, n: bigint): Line => [code, n];
/** Credit (negative). */
export const cr = (code: string, n: bigint): Line => [code, -n];

export interface Step {
  readonly kind: string;
  readonly key: string;
  readonly lines: readonly Line[];
  readonly ref?: string;
  readonly at?: Date;
}

export const draftOf = (s: Step): JournalEntryDraft => ({
  kind: s.kind,
  idempotencyKey: s.key,
  marketId: MARKET,
  occurredAt: s.at ?? OCCURRED,
  ref: { type: "test", id: s.ref ?? s.key },
  postings: s.lines.map(([accountCode, n]) => ({ accountCode, amount: money(n, "EGP") })),
});

export const inTx = <T>(client: SqlClient, fn: (tx: Queryable) => Promise<T>): Promise<T> => client.transaction(fn);

export const counts = async (db: Queryable): Promise<{ entries: number; postings: number; outbox: number }> => {
  const q = async (t: string): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`)).rows[0]?.n);
  return { entries: await q("journal_entries"), postings: await q("postings"), outbox: await q("outbox_events") };
};
