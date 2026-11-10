import { randomUUID } from "node:crypto";
import type { Queryable, SqlClient } from "@outlet/db";
import { seedSellerOrder } from "./seller-orders-fakes.js";

interface Seed { readonly productA: string; readonly skuA: string }

let chain = 0;
const H64 = "a".repeat(64);

/** Platform account codes seeded by migration 0008 (market EG, EGP). */
const PLATFORM = {
  psp_clearing: { type: "psp_clearing", owner_type: "psp", owner_id: "paymob" },
  commission_revenue: { type: "commission_revenue", owner_type: "", owner_id: "" },
  platform_vat_output: { type: "platform_vat_output", owner_type: "", owner_id: "" },
  payouts_in_transit: { type: "payouts_in_transit", owner_type: "", owner_id: "" },
  disputes_in_progress: { type: "disputes_in_progress", owner_type: "psp", owner_id: "paymob" },
} as const;

type Leg = { readonly account: keyof typeof PLATFORM } | { readonly store: string; readonly type: "seller_pending" | "seller_available" };

const accountId = async (tx: Queryable, leg: Leg): Promise<string> => {
  const a = "account" in leg ? PLATFORM[leg.account] : { type: leg.type, owner_type: "store", owner_id: leg.store };
  const code = `${a.type}:EG:EGP${a.owner_id === "" ? "" : `:${a.owner_id}`}`;
  await tx.query(
    `INSERT INTO ledger_accounts (id, code, type, market_id, currency, owner_type, owner_id, sub) VALUES ($1,$2,$3,'EG','EGP',$4,$5,'') ON CONFLICT (code) DO NOTHING`,
    [randomUUID(), code, a.type, a.owner_type, a.owner_id],
  );
  return (await tx.query<{ id: string }>("SELECT id FROM ledger_accounts WHERE code = $1", [code])).rows[0]?.id ?? "";
};

/** One balanced journal entry written straight to the tables (fake hashes; the chain is not verified by these tests). amount > 0 is a debit, < 0 a credit. */
export const postEntry = async (
  raw: SqlClient,
  e: { kind: string; occurredAt: string; refType: string; refId: string; postings: readonly { leg: Leg; amount: number }[] },
): Promise<void> => {
  await raw.transaction(async (tx) => {
    const id = randomUUID();
    const seq = (await tx.query<{ n: string }>("SELECT COALESCE(MAX(chain_seq), 0)::text AS n FROM journal_entries WHERE market_id = 'EG'")).rows[0]?.n ?? "0";
    chain = Math.max(chain, Number(seq)) + 1;
    await tx.query(
      `INSERT INTO journal_entries (id, kind, idempotency_key, market_id, occurred_at, ref_type, ref_id, chain_seq, content_hash, prev_hash, hash)
       VALUES ($1,$2,$3,'EG',$4,$5,$6,$7,$8,$8,$8)`,
      [id, e.kind, `seed:${id}`, e.occurredAt, e.refType, e.refId, chain, H64],
    );
    let line = 1;
    for (const p of e.postings) {
      await tx.query("INSERT INTO postings (id, entry_id, line_no, account_id, amount_minor, currency, market_id) VALUES ($1,$2,$3,$4,$5,'EGP','EG')", [randomUUID(), id, line++, await accountId(tx, p.leg), p.amount]);
    }
  });
};

export interface SeededLedger { readonly sellerOrderId: string; readonly groupId: string }

/**
 * A store's March 2025 story: opening 2,000 pending from February, one order (10,000 gross, 1,000 commission, 140 VAT on commission, 8,860 net),
 * the line closes, a 1,000 refund, a 300 dispute adjustment and a 5,000 payout sent. Expected March: orders_net 8,860, refunds -1,000, adjustments -300,
 * payouts -5,000, net change +2,560, opening 2,000, closing 4,560.
 */
export const seedMarch2025 = async (raw: SqlClient, seed: Seed, storeId: string): Promise<SeededLedger> => {
  const o = await seedSellerOrder(raw, seed, { storeId, totalMinor: 10_000, createdAt: "2025-03-10T09:00:00.000Z" });
  await raw.query("UPDATE seller_orders SET commission_minor = 1000, commission_vat_minor = 140, seller_net_minor = 8860 WHERE id = $1", [o.id]);
  const pending = { store: storeId, type: "seller_pending" } as const;
  const available = { store: storeId, type: "seller_available" } as const;
  await postEntry(raw, { kind: "order_recognised", occurredAt: "2025-02-12T10:00:00.000Z", refType: "order_group", refId: randomUUID(), postings: [{ leg: { account: "psp_clearing" }, amount: 2000 }, { leg: pending, amount: -2000 }] });
  await postEntry(raw, {
    kind: "order_recognised", occurredAt: "2025-03-10T10:00:00.000Z", refType: "order_group", refId: o.groupId,
    postings: [{ leg: { account: "psp_clearing" }, amount: 10_000 }, { leg: pending, amount: -8860 }, { leg: { account: "commission_revenue" }, amount: -1000 }, { leg: { account: "platform_vat_output" }, amount: -140 }],
  });
  await postEntry(raw, { kind: "line_closed", occurredAt: "2025-03-20T10:00:00.000Z", refType: "seller_order", refId: o.id, postings: [{ leg: pending, amount: 8860 }, { leg: available, amount: -8860 }] });
  await postEntry(raw, { kind: "refund_issued", occurredAt: "2025-03-22T10:00:00.000Z", refType: "refund", refId: randomUUID(), postings: [{ leg: available, amount: 1000 }, { leg: { account: "psp_clearing" }, amount: -1000 }] });
  await postEntry(raw, { kind: "dispute_opened", occurredAt: "2025-03-25T10:00:00.000Z", refType: "dispute", refId: randomUUID(), postings: [{ leg: available, amount: 300 }, { leg: { account: "disputes_in_progress" }, amount: -300 }] });
  await postEntry(raw, { kind: "payout_sent", occurredAt: "2025-03-28T10:00:00.000Z", refType: "payout", refId: randomUUID(), postings: [{ leg: available, amount: 5000 }, { leg: { account: "payouts_in_transit" }, amount: -5000 }] });
  return { sellerOrderId: o.id, groupId: o.groupId };
};

let day = 0;
export interface SeededPayout { readonly id: string; readonly sellerOrderId: string }

/** A payout (gross 5,500, one -500 adjustment, net 5,000) with an order line and an adjustment line. Each call takes a fresh one-day cycle. */
export const seedPayout = async (raw: SqlClient, seed: Seed, o: { storeId: string; status?: string }): Promise<SeededPayout> => {
  const status = o.status ?? "SETTLED";
  const cycle = new Date(Date.UTC(2024, 0, 1 + ++day)).toISOString().slice(0, 10);
  const so = await seedSellerOrder(raw, seed, { storeId: o.storeId, status: "CLOSED" });
  const batchId = randomUUID(), payoutId = randomUUID(), accrualId = randomUUID();
  await raw.query("INSERT INTO payout_batches (id, market_id, cycle_start, cycle_end, currency, status) VALUES ($1,'EG',$2,$2,'EGP','COMPLETED')", [batchId, cycle]);
  await raw.query(
    `INSERT INTO payouts (id, batch_id, store_id, market_id, cycle_start, cycle_end, gross_minor, adjustments_minor, net_minor, currency, status, idempotency_key, sent_at, settled_at)
     VALUES ($1,$2,$3,'EG',$4,$4,5500,-500,5000,'EGP',$5,$6,$7,$8)`,
    [payoutId, batchId, o.storeId, cycle, status, `seed-${payoutId}`, status === "SENT" || status === "SETTLED" ? `${cycle}T10:00:00Z` : null, status === "SETTLED" ? `${cycle}T12:00:00Z` : null],
  );
  await raw.query(
    `INSERT INTO payout_accruals (id, seller_order_id, store_id, market_id, amount_minor, currency, status, closed_at, eligible_at, payout_id)
     VALUES ($1,$2,$3,'EG',5500,'EGP','SCHEDULED',now(),now(),$4)`,
    [accrualId, so.id, o.storeId, payoutId],
  );
  await raw.query("INSERT INTO payout_lines (id, payout_id, store_id, market_id, kind, accrual_id, amount_minor, currency) VALUES ($1,$2,$3,'EG','order',$4,5500,'EGP')", [randomUUID(), payoutId, o.storeId, accrualId]);
  await raw.query("INSERT INTO payout_lines (id, payout_id, store_id, market_id, kind, accrual_id, amount_minor, currency) VALUES ($1,$2,$3,'EG','adjustment',NULL,-500,'EGP')", [randomUUID(), payoutId, o.storeId]);
  return { id: payoutId, sellerOrderId: so.id };
};
