import { randomUUID } from "node:crypto";
import { createAdminAccess } from "@outlet/admin-access";
import type { AdminAccess } from "@outlet/admin-access";
import type { AuditEntryInput } from "@outlet/audit-log";
import type { SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { Ledger, accountCode } from "@outlet/ledger";
import type { AccountType } from "@outlet/ledger";
import { money } from "@outlet/money";
import type { Principal } from "@outlet/policy";
import { AvailabilityMover, CodRemittanceImporter, DisputeHolds, IntegrityJob, PayoutService, ReconciliationJob, SettlementImporter } from "../src/index.js";
import type { ConsumedEvent } from "../src/index.js";
import { FakePayoutDestinations, FakePayoutRail } from "../src/testing.js";

export const T0 = new Date("2030-01-01T10:00:00.000Z");
export const DAY = 86_400_000;
/** Monday of the Cairo week after T0 (2030-01-07): its payout cycle is Mon 2029-12-31 .. Sun 2030-01-06. */
export const MONDAY = new Date("2030-01-07T08:00:00.000Z");
export const THRESHOLD = 1_000_000n;

export interface World {
  readonly raw: SqlClient;
  readonly app: RoleSqlClient<"outlet_app">;
  readonly worker: RoleSqlClient<"outlet_worker">;
  readonly admin: AdminAccess;
  readonly audits: AuditEntryInput[];
  readonly clock: { now: Date };
  readonly rail: FakePayoutRail;
  readonly destinations: FakePayoutDestinations;
  readonly svc: PayoutService;
  readonly mover: AvailabilityMover;
  readonly disputes: DisputeHolds;
  readonly settlements: SettlementImporter;
  readonly cod: CodRemittanceImporter;
  readonly recon: ReconciliationJob;
  readonly integrity: IntegrityJob;
  readonly close: () => Promise<void>;
  readonly newStore: (name?: string) => Promise<string>;
  readonly finance: () => Promise<Principal>;
  readonly seedOrder: (o: OrderSeed) => Promise<{ groupId: string; sellerOrderId: string; intentId: string }>;
  readonly post: (kind: string, key: string, lines: readonly (readonly [AccountType, bigint, string?, string?])[]) => Promise<string>;
  readonly balance: (type: AccountType, owner?: string) => Promise<bigint>;
  readonly closeOrder: (o: { sellerOrderId: string; storeId: string; closedAt: Date; amount?: bigint }) => Promise<ConsumedEvent>;
}

export interface OrderSeed {
  readonly storeId: string;
  readonly netMinor: bigint;
  readonly status?: string;
  readonly closedAt?: Date | null;
  readonly deliveredAt?: Date | null;
  readonly method?: string;
  readonly provider?: string;
  readonly providerRef?: string | null;
  readonly intentStatus?: string;
  readonly fundsFlow?: "collect_payout" | "psp_split";
  readonly totalMinor?: bigint;
  readonly currency?: string;
}

const acct = (type: AccountType, owner?: string, sub?: string): string =>
  accountCode({ type, market: "EG", currency: "EGP", ...(owner === undefined ? {} : { owner }), ...(sub === undefined ? {} : { sub }) });

export const buildWorld = async (): Promise<World> => {
  const { client: raw, close } = await createTestClient();
  const clock = { now: new Date(T0) };
  const audits: AuditEntryInput[] = [];
  const app = roleClient(raw, "outlet_app");
  const worker = roleClient(raw, "outlet_worker");
  const admin = createAdminAccess({
    db: app, audit: { appendIn: (_tx, e) => { audits.push(e); return Promise.resolve(); } }, clock: () => clock.now, thresholdMinor: THRESHOLD,
  });
  const rail = new FakePayoutRail();
  const destinations = new FakePayoutDestinations();
  const common = { client: worker, currency: "EGP" as const, now: () => clock.now };
  const readApproval = async (id: string): Promise<{ action: string; targetType: string; targetId: string; status: string } | null> => {
    const r = await raw.query<{ action: string; target_type: string; target_id: string; status: string }>("SELECT action, target_type, target_id, status FROM approval_requests WHERE id = $1", [id]);
    const row = r.rows[0];
    return row ? { action: row.action, targetType: row.target_type, targetId: row.target_id, status: row.status } : null;
  };
  const svc = new PayoutService({ ...common, admin, rail, destinations, readApproval, audit: { append: (e) => { audits.push(e); return Promise.resolve(); } } });

  const newStore = async (name = randomUUID().slice(0, 8)): Promise<string> => {
    const sellerId = randomUUID();
    const storeId = randomUUID();
    await raw.query(
      `INSERT INTO sellers (id, home_market_id, market_id, legal_type, legal_name_ar, legal_name_en, commercial_register_no, tax_card_no, governorate_code, governorate_name_ar, status)
       VALUES ($1,'EG','EG','company','شركة','Company',$2,$3,'CAI','القاهرة','active')`,
      [sellerId, `CR-${name}-${sellerId}`, `TX-${sellerId}`],
    );
    await raw.query(
      "INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country, status) VALUES ($1,$2,'EG',$3,'متجر','local','EG','ACTIVE')",
      [storeId, sellerId, `s-${storeId.slice(0, 8)}`],
    );
    destinations.set(storeId, { instrumentId: randomUUID(), ibanLast4: "1234", accountHolderName: "Nile Fashion LLC", legalName: "Nile Fashion" });
    return storeId;
  };

  const seedOrder: World["seedOrder"] = async (o) => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const groupId = randomUUID();
    const sellerOrderId = randomUUID();
    const intentId = randomUUID();
    const total = o.totalMinor ?? o.netMinor + 1000n;
    const stamp = T0.toISOString();
    await raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [userId, stamp]);
    await raw.query(
      `INSERT INTO checkout_sessions (id, user_id, market_id, currency, quote, quote_hash, payment_method, price_lock_expires_at) VALUES ($1,$2,'EG','EGP','{}'::jsonb,$3,'card',$4)`,
      [sessionId, userId, Buffer.alloc(32, 1), stamp],
    );
    await raw.query(
      `INSERT INTO order_groups (id, user_id, market_id, currency, status, funds_flow, checkout_session_id, idempotency_key, payment_method, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor, placed_at)
       VALUES ($1,$2,'EG','EGP','PAID',$3,$4,$5,$6,$7,0,0,0,$7,$8)`,
      [groupId, userId, o.fundsFlow ?? "collect_payout", sessionId, randomUUID(), o.method ?? "card", total.toString(), stamp],
    );
    await raw.query(
      `INSERT INTO seller_orders (id, order_group_id, store_id, user_id, market_id, currency, status, funds_flow, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor,
                                  commission_bp_snapshot, commission_minor, commission_vat_minor, seller_net_minor, delivered_at, closed_at)
       VALUES ($1,$2,$3,$4,'EG',$5,$6,$7,$8,0,0,0,$8,1500,0,0,$9,$10,$11)`,
      [sellerOrderId, groupId, o.storeId, userId, o.currency ?? "EGP", o.status ?? "PAID", o.fundsFlow ?? "collect_payout", total.toString(), o.netMinor.toString(), o.deliveredAt?.toISOString() ?? null, o.closedAt?.toISOString() ?? null],
    );
    await raw.query(
      `INSERT INTO payment_intents (id, order_group_id, user_id, market_id, provider, provider_ref, method, amount_minor, currency, status, updated_at)
       VALUES ($1,$2,$3,'EG',$4,$5,$6,$7,'EGP',$8,$9)`,
      [intentId, groupId, userId, o.provider ?? "paymob", o.providerRef === undefined ? `ref-${intentId}` : o.providerRef, o.method ?? "card", total.toString(), o.intentStatus ?? "CAPTURED", stamp],
    );
    return { groupId, sellerOrderId, intentId };
  };

  const post: World["post"] = async (kind, key, lines) => {
    const r = await raw.transaction((tx) => Ledger.post(tx, {
      kind, idempotencyKey: key, marketId: "EG", occurredAt: clock.now, ref: { type: "test", id: key },
      postings: lines.map(([type, amount, owner, sub]) => ({ accountCode: acct(type, owner, sub), amount: money(amount, "EGP") })),
    }));
    return r.entryId;
  };
  const balance: World["balance"] = async (type, owner) => (await raw.transaction((tx) => Ledger.balance(tx, acct(type, owner)))).amountMinor;

  const closeOrder: World["closeOrder"] = async (o) => {
    await raw.query("UPDATE seller_orders SET status = 'CLOSED', closed_at = $2 WHERE id = $1", [o.sellerOrderId, o.closedAt.toISOString()]);
    const net = (await raw.query<{ n: string }>("SELECT seller_net_minor::text AS n FROM seller_orders WHERE id = $1", [o.sellerOrderId])).rows[0]?.n ?? "0";
    return { id: uuidv7(), type: "seller_order.closed", aggregateId: o.sellerOrderId, marketId: "EG", payload: { amount_minor: o.amount === undefined ? net : o.amount.toString() } };
  };

  const seedGrant = (staffId: string, role: string): Promise<unknown> =>
    raw.query(
      "INSERT INTO staff_role_assignments (id, staff_id, role_code, market_id, granted_by, reason, starts_at, expires_at, created_at) VALUES ($1,$2,$3,'EG',$2,'seed','2020-01-01','2100-01-01','2020-01-01')",
      [uuidv7(), staffId, role],
    );
  const finance = async (): Promise<Principal> => {
    const id = uuidv7();
    await seedGrant(id, "finance");
    return admin.buildPrincipal("EG", id);
  };

  return {
    raw, app, worker, admin, audits, clock, rail, destinations, svc, mover: new AvailabilityMover(common), disputes: new DisputeHolds(common), settlements: new SettlementImporter(common), cod: new CodRemittanceImporter(common),
    recon: new ReconciliationJob(common), integrity: new IntegrityJob(common), close, newStore, finance, seedOrder, post, balance, closeOrder,
  };
};

export const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error && "code" in e && typeof e.code === "string") return e.code;
    throw e;
  }
  return "NO_ERROR";
};

/** Funds a closed seller order for a store: pending credited by an order entry, then moved to seller_available by the mover. */
export const fundClosed = async (w: World, storeId: string, net: bigint, closedAt: Date, key: string = randomUUID()): Promise<{ sellerOrderId: string }> => {
  const o = await w.seedOrder({ storeId, netMinor: net });
  await w.post("order_recognised", `order_paid:${key}`, [["psp_clearing", net, "paymob"], ["seller_pending", -net, storeId]]);
  const ev = await w.closeOrder({ sellerOrderId: o.sellerOrderId, storeId, closedAt });
  await w.mover.onSellerOrderClosed(ev);
  return { sellerOrderId: o.sellerOrderId };
};

export const ownPayout = async (w: World, storeId: string, ids: readonly string[]): Promise<string | undefined> =>
  (await w.raw.query<{ id: string }>("SELECT id FROM payouts WHERE store_id = $1 AND id = ANY($2::uuid[])", [storeId, ids])).rows[0]?.id;

/** Funds a store and builds its payout at `now`. */
export const scheduledPayout = async (w: World, storeId: string, net: bigint, now: Date = MONDAY): Promise<string> => {
  await fundClosed(w, storeId, net, T0);
  w.clock.now = now;
  const b = await w.svc.buildCycle("EG", now);
  const id = await ownPayout(w, storeId, b.payoutIds);
  if (id === undefined) throw new Error(`no payout built for ${storeId}: ${JSON.stringify(b.skipped)}`);
  return id;
};
