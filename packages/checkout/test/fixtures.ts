import { randomUUID } from "node:crypto";
import { brandClient } from "@outlet/db";
import type { Queryable, RoleSqlClient, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { uuidv7 } from "@outlet/ids";
import { ReservationService } from "@outlet/inventory";
import { Ledger, accountCode } from "@outlet/ledger";
import { money } from "@outlet/money";
import type { Money } from "@outlet/money";
import { InMemoryTaxRateProvider } from "@outlet/tax";
import { CheckoutService, ExpirySweeper, OrderCloseJob, PgStoreCredit, WebhookProcessor } from "../src/index.js";
import type { CheckoutConfig, PaymentMethod, PlaceInput } from "../src/index.js";
import {
  FakeAddress, FakeBilling, FakeCipher, FakeCommission, FakeKillSwitches, FakePaymentProvider, FakePrices, FakeRisk, FakeShipping, FakeSubMerchants, FakeTaxCategories,
  HmacQuoteTokens, RecordingRefunds, defaultConfig,
} from "../src/testing.js";

export const CAT = "00000000-0000-4000-8000-0000000c0011";
const T0 = Date.parse("2030-01-01T00:00:00.000Z");

export interface Sku { readonly skuId: string; readonly productId: string; readonly storeId: string }

export interface World {
  readonly raw: SqlClient;
  readonly app: RoleSqlClient<"outlet_app">;
  readonly workerClient: RoleSqlClient<"outlet_worker">;
  readonly statements: string[];
  readonly clock: { t: number };
  readonly fakes: {
    provider: FakePaymentProvider; shipping: FakeShipping; risk: FakeRisk; commission: FakeCommission; kill: FakeKillSwitches; prices: FakePrices;
    refunds: RecordingRefunds; subs: FakeSubMerchants; address: FakeAddress;
  };
  readonly reservations: ReservationService;
  readonly svc: CheckoutService;
  readonly makeSvc: (config: Partial<CheckoutConfig>) => CheckoutService;
  readonly webhooks: WebhookProcessor;
  readonly sweeper: ExpirySweeper;
  readonly closer: OrderCloseJob;
  readonly stores: readonly [string, string, string];
  readonly newUser: () => Promise<string>;
  readonly seedSku: (storeId: string, priceMinor: bigint, stock?: number) => Promise<Sku>;
  readonly fillBag: (userId: string, items: readonly { sku: Sku; qty: number }[]) => Promise<void>;
  readonly grantCredit: (userId: string, amountMinor: bigint) => Promise<void>;
  readonly outboxTypes: () => Promise<string[]>;
  readonly free: (sku: Sku) => Promise<number>;
  readonly close: () => Promise<void>;
}

export const buildWorld = async (): Promise<World> => {
  const { client: raw, close } = await createTestClient();
  const statements: string[] = [];
  const wrap = <R extends "outlet_app" | "outlet_worker">(role: R): RoleSqlClient<R> => {
    const base = roleClient(raw, role);
    return brandClient<R>({
      query: (sql, params) => { statements.push(sql); return base.query(sql, params); },
      transaction: (fn) => base.transaction((tx: Queryable) => fn({ query: (sql, params) => { statements.push(sql); return tx.query(sql, params); } })),
    });
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
    await raw.query(
      `INSERT INTO catalog_public_stores (id, market_id, slug, display_name_ar, kind, status, verified_badge, ships_from_country, followers_count, discount_display_mode, legal_identity, updated_at)
       VALUES ($1,'EG',$2,$3,'local','ACTIVE',false,'EG',0,'public','{}'::jsonb,$4)`,
      [storeId, slug, `متجر ${slug}`, stamp],
    );
    await raw.query("INSERT INTO inventory_locations (id, market_id, store_id) VALUES ($1,'EG',$2)", [randomUUID(), storeId]);
    return storeId;
  };
  const stores = [await mkStore("store-a"), await mkStore("store-b"), await mkStore("store-c")] as const;

  const newUser = async (): Promise<string> => {
    const u = randomUUID();
    await raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [u, stamp]);
    return u;
  };

  const seedSku: World["seedSku"] = async (storeId, price, stock = 5) => {
    const productId = randomUUID();
    const skuId = randomUUID();
    await raw.query(
      `INSERT INTO products (id, store_id, market_id, primary_category_id, status, title_ar, description_ar, condition_grade_code, published_at) VALUES ($1,$2,'EG',$3,'PUBLISHED','فستان','وصف','new_with_tags',$4)`,
      [productId, storeId, CAT, stamp],
    );
    await raw.query("INSERT INTO skus (id, product_id, store_id, market_id, seller_sku, price_minor, currency) VALUES ($1,$2,$3,'EG',$4,$5,'EGP')", [skuId, productId, storeId, `S-${skuId}`, price.toString()]);
    const variants = JSON.stringify([{ sku_id: skuId, option_values: {}, price_minor: price.toString(), currency: "EGP" }]);
    await raw.query(
      `INSERT INTO catalog_public_listings (id, store_ref, market_id, store, status, title_ar, description_ar, primary_category_id, condition_grade_code, condition_grade, min_price_minor, currency, attributes, variants, version, published_at, updated_at)
       VALUES ($1,$2,'EG','{}'::jsonb,'PUBLISHED','فستان','وصف',$3,'new_with_tags','{}'::jsonb,$4,'EGP','{}'::jsonb,$5::jsonb,1,$6,$6)`,
      [productId, storeId, CAT, price.toString(), variants, stamp],
    );
    await raw.query("INSERT INTO inventory_levels (sku_id, location_id, store_id, market_id, on_hand) SELECT $1, id, $2, 'EG', $3 FROM inventory_locations WHERE store_id = $2", [skuId, storeId, stock]);
    return { skuId, productId, storeId };
  };

  const fillBag: World["fillBag"] = async (userId, items) => {
    const cartId = randomUUID();
    await raw.query("INSERT INTO carts (id, user_id, market_id, currency) VALUES ($1,$2,'EG','EGP')", [cartId, userId]);
    for (const { sku, qty } of items) {
      await raw.query(
        `INSERT INTO cart_lines (id, cart_id, user_id, market_id, sku_id, product_id, store_ref, qty, price_at_add_minor, currency) VALUES ($1,$2,$3,'EG',$4,$5,$6,$7,1,'EGP')`,
        [randomUUID(), cartId, userId, sku.skuId, sku.productId, sku.storeId, qty],
      );
    }
  };

  const grantCredit: World["grantCredit"] = async (userId, amountMinor) => {
    await raw.transaction((tx) => Ledger.post(tx, {
      kind: "store_credit_granted", idempotencyKey: `grant:${userId}:${randomUUID()}`, marketId: "EG", occurredAt: now(), ref: { type: "user", id: userId },
      postings: [
        { accountCode: accountCode({ type: "goodwill_expense", market: "EG", currency: "EGP" }), amount: money(amountMinor, "EGP") },
        { accountCode: accountCode({ type: "store_credit", market: "EG", currency: "EGP", owner: userId, sub: "goodwill" }), amount: money(-amountMinor, "EGP") },
      ],
    }));
  };

  const fakes = {
    provider: new FakePaymentProvider(), shipping: new FakeShipping(), risk: new FakeRisk(), commission: new FakeCommission(), kill: new FakeKillSwitches(), prices: new FakePrices(),
    refunds: new RecordingRefunds(), subs: new FakeSubMerchants(), address: new FakeAddress(),
  };
  const reservations = new ReservationService({ client: app, marketId: "EG", now });
  const common = {
    marketId: "EG", now, config: defaultConfig(), reservations, provider: fakes.provider, shipping: fakes.shipping, address: fakes.address, risk: fakes.risk, commission: fakes.commission,
    taxCategories: new FakeTaxCategories(), taxRates: InMemoryTaxRateProvider.withMarketDefaults(["eg"]), credit: new PgStoreCredit("EGP"), tokens: new HmacQuoteTokens(), prices: fakes.prices,
    killSwitches: fakes.kill, subMerchants: fakes.subs, billing: new FakeBilling(), refunds: fakes.refunds,
  };
  const svc = new CheckoutService({ ...common, client: app });
  const worker = { ...common, client: workerClient, cipher: new FakeCipher() };
  return {
    raw, app, workerClient, statements, clock, fakes, reservations, svc, makeSvc: (c) => new CheckoutService({ ...common, config: defaultConfig(c), client: app }), webhooks: new WebhookProcessor(worker), sweeper: new ExpirySweeper(worker), closer: new OrderCloseJob(worker), stores, newUser, seedSku, fillBag, grantCredit,
    outboxTypes: async () => (await raw.query<{ t: string }>("SELECT event_type AS t FROM outbox_events ORDER BY occurred_at, id")).rows.map((r) => r.t),
    free: async (sku) => Number((await raw.query<{ f: string }>("SELECT (on_hand - committed)::text AS f FROM inventory_levels WHERE sku_id = $1", [sku.skuId])).rows[0]?.f ?? "0"),
    close,
  };
};

export const ADDR = "01900000-0000-7000-8000-0000000000ad";

/** quote then place with a fresh Idempotency-Key. */
export const quoteAndPlace = async (w: World, userId: string, method: PaymentMethod, over: Partial<PlaceInput> & { creditRequested?: Money } = {}) => {
  const q = await w.svc.quote(userId, { addressRef: ADDR, method, ...(over.creditRequested === undefined ? {} : { creditRequested: over.creditRequested }) });
  const key = over.idempotencyKey ?? uuidv7();
  return { q, key, place: () => w.svc.place(userId, { addressRef: ADDR, method, idempotencyKey: key, quoteToken: q.token, quote: q.quote, ...(over.creditRequested === undefined ? {} : { creditRequested: over.creditRequested }) }) };
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

export const intentOf = async (w: World, groupId: string): Promise<{ id: string; status: string; provider_ref: string | null; amount_minor: string }> =>
  (await w.raw.query<{ id: string; status: string; provider_ref: string | null; amount_minor: string }>("SELECT id, status, provider_ref, amount_minor::text FROM payment_intents WHERE order_group_id = $1", [groupId])).rows[0] ?? (() => { throw new Error("no intent"); })();

export const paidWebhook = (w: World, intent: { id: string; provider_ref: string | null; amount_minor: string }, eventId: string, type: "payment.succeeded" | "payment.failed" = "payment.succeeded") =>
  w.fakes.provider.webhook({ id: eventId, type, merchantReference: intent.id, providerRef: intent.provider_ref ?? "ref", amountMinor: BigInt(intent.amount_minor) });
