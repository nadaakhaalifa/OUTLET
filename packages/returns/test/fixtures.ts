import { randomUUID } from "node:crypto";
import { createAdminAccess } from "@outlet/admin-access";
import type { AdminAccess } from "@outlet/admin-access";
import { brandClient } from "@outlet/db";
import type { Queryable, RoleSqlClient, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { Ledger, accountCode } from "@outlet/ledger";
import { money } from "@outlet/money";
import type { Principal } from "@outlet/policy";
import { InventoryRestock, RefundService, ReturnService } from "../src/index.js";
import type { ReturnsConfig } from "../src/index.js";
import { FakeEvidence, FakeKill, FakePolicy, FakeProvider, FakeRestock } from "../src/testing.js";

export const CAT = "00000000-0000-4000-8000-0000000c0011";
export const T0 = Date.parse("2030-01-01T00:00:00.000Z");
export const DAY = 86_400_000;

export interface World {
  readonly raw: SqlClient;
  readonly app: RoleSqlClient<"outlet_app">;
  readonly workerClient: RoleSqlClient<"outlet_worker">;
  readonly clock: { t: number };
  readonly fakes: { policy: FakePolicy; evidence: FakeEvidence; restock: FakeRestock; provider: FakeProvider; kill: FakeKill };
  readonly returns: ReturnService;
  readonly refunds: RefundService;
  readonly adminAccess: AdminAccess;
  readonly make: (config?: Partial<ReturnsConfig>, realRestock?: boolean) => { returns: ReturnService; refunds: RefundService };
  readonly stores: readonly [string, string];
  readonly newUser: () => Promise<string>;
  readonly order: (o: OrderOpts) => Promise<Order>;
  readonly seller: (storeId: string, roles?: string[]) => Principal;
  readonly admin: (roles: string[]) => Principal;
  readonly close: () => Promise<void>;
}

export interface OrderOpts {
  readonly userId: string;
  readonly storeId: string;
  readonly lines: readonly { price: bigint; qty?: number; discount?: bigint; disclosedDefect?: boolean }[];
  readonly bp?: number;
  readonly shipping?: bigint;
  readonly shippingVat?: bigint;
  readonly method?: "card" | "cod" | "bnpl" | "fawry" | "wallet" | "instapay" | "store_credit";
  readonly credit?: bigint;
  readonly deliveredDaysAgo?: number | null;
  readonly closed?: boolean;
  readonly bnplProvider?: string;
}
export interface Order { readonly groupId: string; readonly sellerOrderId: string; readonly lineIds: readonly string[]; readonly skuIds: readonly string[]; readonly total: bigint; readonly intentId: string }

const pct = (v: bigint, bp: bigint): bigint => {
  const n = v * bp;
  const q = n / 10_000n;
  const r = n % 10_000n;
  return r * 2n > 10_000n || (r * 2n === 10_000n && q % 2n === 1n) ? q + 1n : q;
};

export const buildWorld = async (): Promise<World> => {
  const { client: raw, close } = await createTestClient();
  const wrap = <R extends "outlet_app" | "outlet_worker">(role: R): RoleSqlClient<R> => {
    const base = roleClient(raw, role);
    return brandClient<R>({ query: (sql, params) => base.query(sql, params), transaction: (fn) => base.transaction((tx: Queryable) => fn(tx)) });
  };
  const app = wrap("outlet_app");
  const workerClient = wrap("outlet_worker");
  const clock = { t: T0 };
  const now = (): Date => new Date(clock.t);
  const stamp = new Date(T0).toISOString();

  const mkStore = async (slug: string): Promise<string> => {
    const sellerId = randomUUID();
    const storeId = randomUUID();
    await raw.query(
      `INSERT INTO sellers (id, home_market_id, market_id, legal_type, legal_name_ar, legal_name_en, commercial_register_no, tax_card_no, governorate_code, governorate_name_ar, status)
       VALUES ($1,'EG','EG','company','شركة','Company',$2,$3,'CAI','القاهرة','active')`,
      [sellerId, `CR-${slug}`, `TX-${slug}`],
    );
    await raw.query(`INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country, status) VALUES ($1,$2,'EG',$3,$4,'local','EG','ACTIVE')`, [storeId, sellerId, slug, `متجر ${slug}`]);
    await raw.query("INSERT INTO inventory_locations (id, market_id, store_id) VALUES ($1,'EG',$2)", [randomUUID(), storeId]);
    return storeId;
  };
  const stores = [await mkStore("store-a"), await mkStore("store-b")] as const;
  const newUser = async (): Promise<string> => {
    const u = randomUUID();
    await raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [u, stamp]);
    return u;
  };

  const fakes = { policy: new FakePolicy(), evidence: new FakeEvidence(), restock: new FakeRestock(), provider: new FakeProvider(), kill: new FakeKill() };
  let lastAdmin: AdminAccess | undefined;
  const make: World["make"] = (config, realRestock = false) => {
    const adminAccess = createAdminAccess({ db: app, audit: { appendIn: () => Promise.resolve() }, clock: now, thresholdMinor: config?.dualApproval?.thresholdMinor ?? 500_000n });
    lastAdmin = adminAccess;
    const deps = { admin: adminAccess, app, worker: workerClient, marketId: "EG", policy: fakes.policy, evidence: fakes.evidence, restock: realRestock ? new InventoryRestock(app, "EG") : fakes.restock, provider: fakes.provider, kill: fakes.kill, now, ...(config === undefined ? {} : { config }) };
    return { returns: new ReturnService(deps), refunds: new RefundService(deps) };
  };
  const base = make();
  const adminAccess = lastAdmin!;

  const order: World["order"] = async (o) => {
    const bp = o.bp ?? 1500;
    const ship = o.shipping ?? 0n;
    const shipVat = o.shippingVat ?? 0n;
    const method = o.method ?? "card";
    // eslint-disable-next-line district/no-float-money -- test fixture arithmetic on bigint piastres
    const items = o.lines.reduce((a, l) => a + l.price * BigInt(l.qty ?? 1), 0n);
    const disc = o.lines.reduce((a, l) => a + (l.discount ?? 0n), 0n);
    const base0 = items - disc;
    const comm = pct(base0, BigInt(bp));
    const commVat = pct(comm, 1400n);
    const net = base0 - comm - commVat;
    const total = base0 + ship;
    const credit = o.credit ?? 0n;
    const groupId = randomUUID();
    const soId = randomUUID();
    const sessionId = randomUUID();
    await raw.query(
      `INSERT INTO checkout_sessions (id, user_id, market_id, currency, quote, quote_hash, payment_method, price_lock_expires_at, order_group_id, status)
       VALUES ($1,$2,'EG','EGP','{}'::jsonb, decode(repeat('00',32),'hex'), $3, $4, $5, 'completed')`, [sessionId, o.userId, method, stamp, groupId]);
    await raw.query(
      `INSERT INTO order_groups (id, user_id, market_id, currency, status, funds_flow, checkout_session_id, idempotency_key, payment_method, items_subtotal_minor, discount_minor, shipping_minor, shipping_vat_minor, vat_minor, store_credit_minor, total_minor, placed_at, paid_at)
       VALUES ($1,$2,'EG','EGP','PAID','psp_split',$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,$12)`,
      [groupId, o.userId, sessionId, randomUUID(), method, items.toString(), disc.toString(), ship.toString(), shipVat.toString(), credit.toString(), total.toString(), stamp],
    );
    const delivered = o.deliveredDaysAgo === undefined ? 0 : o.deliveredDaysAgo;
    const deliveredAt = delivered === null ? null : new Date(T0 - delivered * DAY).toISOString();
    await raw.query(
      `INSERT INTO seller_orders (id, order_group_id, store_id, user_id, market_id, currency, status, funds_flow, items_subtotal_minor, platform_discount_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor,
                                  commission_bp_snapshot, commission_minor, commission_vat_minor, seller_net_minor, delivered_at, closed_at)
       VALUES ($1,$2,$3,$4,'EG','EGP',$5,'psp_split',$6,$7,$8,$9,0,$10,$11,$12,$13,$14,$15,$16)`,
      [soId, groupId, o.storeId, o.userId, o.closed === true ? "CLOSED" : delivered === null ? "SHIPPED" : "DELIVERED", items.toString(), disc.toString(), ship.toString(), shipVat.toString(), total.toString(), bp, comm.toString(), commVat.toString(), net.toString(), deliveredAt, o.closed === true ? deliveredAt : null],
    );
    const lineIds: string[] = [];
    const skuIds: string[] = [];
    for (const l of o.lines) {
      const productId = randomUUID();
      const skuId = randomUUID();
      await raw.query(`INSERT INTO products (id, store_id, market_id, primary_category_id, status, title_ar, description_ar, condition_grade_code, published_at) VALUES ($1,$2,'EG',$3,'PUBLISHED','فستان','وصف','new_with_tags',$4)`, [productId, o.storeId, CAT, stamp]);
      await raw.query("INSERT INTO skus (id, product_id, store_id, market_id, seller_sku, price_minor, currency) VALUES ($1,$2,$3,'EG',$4,$5,'EGP')", [skuId, productId, o.storeId, `S-${skuId}`, l.price.toString()]);
      await raw.query("INSERT INTO inventory_levels (sku_id, location_id, store_id, market_id, on_hand) SELECT $1, id, $2, 'EG', 5 FROM inventory_locations WHERE store_id = $2", [skuId, o.storeId]);
      let cardId: string | null = null;
      if (l.disclosedDefect === true) {
        cardId = randomUUID();
        await raw.query(
          `INSERT INTO defect_cards (id, product_id, store_id, market_id, version, grade_code, summary_ar, affects_function, defect_count, inspected_by, inspected_at) VALUES ($1,$2,$3,'EG',1,'new_with_tags','عيب بسيط',false,1,'seller',$4)`,
          [cardId, productId, o.storeId, stamp],
        );
      }
      const lineId = randomUUID();
      await raw.query(
        `INSERT INTO order_lines (id, seller_order_id, order_group_id, store_id, user_id, market_id, sku_id, product_id, title_ar_snapshot, condition_grade_snapshot, defect_card_id_snapshot, defect_ack_at, qty, unit_price_minor, currency,
                                  platform_discount_minor, tax_category, vat_rate_bp, vat_minor, claim_type_snapshot)
         VALUES ($1,$2,$3,$4,$5,'EG',$6,$7,'فستان','new_with_tags',$8,$9,$10,$11,'EGP',$12,'standard',1400,0,'plain')`,
        [lineId, soId, groupId, o.storeId, o.userId, skuId, productId, cardId, cardId === null ? null : stamp, l.qty ?? 1, l.price.toString(), (l.discount ?? 0n).toString()],
      );
      lineIds.push(lineId);
      skuIds.push(skuId);
    }
    const intentId = randomUUID();
    const ext = total - credit;
    await raw.query(
      `INSERT INTO payment_intents (id, order_group_id, user_id, market_id, provider, provider_ref, method, bnpl_provider, amount_minor, currency, status)
       VALUES ($1,$2,$3,'EG','fake',$4,$5,$6,$7,'EGP','CAPTURED')`,
      [intentId, groupId, o.userId, `pr_${intentId}`, method, o.bnplProvider ?? null, method === "cod" || method === "store_credit" ? "0" : ext.toString()],
    );
    // order_paid entry (ledger spec 4.1), so later refund entries net against real balances and the trial balance can be checked.
    const cr = (type: Parameters<typeof accountCode>[0]["type"], owner?: string) => accountCode({ type, market: "EG", currency: "EGP", ...(owner === undefined ? {} : { owner }) });
    const debitAcc = method === "bnpl" ? cr("bnpl_clearing", o.bnplProvider ?? "valu") : cr("psp_clearing", "paymob");
    const shipNet = ship - shipVat;
    const credits = [
      { accountCode: cr("seller_pending", o.storeId), amount: money(-net, "EGP") },
      { accountCode: cr("commission_revenue"), amount: money(-comm, "EGP") },
      { accountCode: cr("platform_vat_output"), amount: money(-(commVat + shipVat), "EGP") },
      ...(shipNet > 0n ? [{ accountCode: cr("shipping_revenue"), amount: money(-shipNet, "EGP") }] : []),
    ].filter((p) => p.amount.amountMinor !== 0n);
    const credLegs: { accountCode: string; amount: ReturnType<typeof money> }[] = [];
    if (credit > 0n) {
      const code = accountCode({ type: "store_credit", market: "EG", currency: "EGP", owner: o.userId, sub: "goodwill" });
      credLegs.push({ accountCode: code, amount: money(credit, "EGP") });
    }
    await raw.transaction(async (tx) => {
      if (credit > 0n) {
        await Ledger.post(tx, {
          kind: "store_credit_granted", idempotencyKey: `grant:${groupId}`, marketId: "EG", occurredAt: now(), ref: { type: "user", id: o.userId },
          postings: [{ accountCode: cr("goodwill_expense"), amount: money(credit, "EGP") }, { accountCode: credLegs[0]?.accountCode ?? "", amount: money(-credit, "EGP") }],
        });
      }
      await Ledger.post(tx, {
        kind: "order_recognised", idempotencyKey: `order_paid:${groupId}`, marketId: "EG", occurredAt: now(), ref: { type: "order_group", id: groupId },
        postings: [...(ext > 0n ? [{ accountCode: debitAcc, amount: money(ext, "EGP") }] : []), ...credLegs, ...credits],
      });
      if (o.closed === true) {
        // The availability mover's entry (ledger spec 4.x): pending -> available once the line closes. RefundService keys on it.
        await Ledger.post(tx, {
          kind: "line_closed", idempotencyKey: `line_closed:${soId}`, marketId: "EG", occurredAt: now(), ref: { type: "seller_order", id: soId },
          postings: [{ accountCode: cr("seller_pending", o.storeId), amount: money(net, "EGP") }, { accountCode: cr("seller_available", o.storeId), amount: money(-net, "EGP") }],
        });
      }
      if (credit > 0n) {
        const acct = await tx.query<{ id: string }>("SELECT id FROM ledger_accounts WHERE code = $1", [credLegs[0]?.accountCode ?? ""]);
        const entry = await tx.query<{ id: string }>("SELECT id FROM journal_entries WHERE idempotency_key = $1", [`order_paid:${groupId}`]);
        await tx.query(
          `INSERT INTO ledger_holds (id, user_id, account_id, market_id, amount_minor, currency, ref_type, ref_id, status, captured_entry_id, idempotency_key, expires_at)
           VALUES ($1,$2,$3,'EG',$4,'EGP','order_group',$5,'CAPTURED',$6,$7,$8)`,
          [randomUUID(), o.userId, acct.rows[0]?.id, credit.toString(), groupId, entry.rows[0]?.id, `hold:${groupId}`, stamp],
        );
      }
    });
    return { groupId, sellerOrderId: soId, lineIds, skuIds, total, intentId };
  };

  const seller = (storeId: string, roles: string[] = ["manager"]): Principal => ({ kind: "seller_staff", userId: randomUUID(), marketId: "EG", storeIds: [storeId], roles, scopes: [] });
  const admin = (roles: string[]): Principal => ({ kind: "admin", userId: randomUUID(), marketId: "EG", roles, scopes: [] });
  return { raw, app, workerClient, clock, fakes, returns: base.returns, refunds: base.refunds, adminAccess, make, stores, newUser, order, seller, admin, close };
};

export const errCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error && "code" in e && typeof e.code === "string") return e.code;
    throw e;
  }
  return "NO_ERROR";
};
