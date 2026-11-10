/**
 * Schema guard for migration 0016 (orders + checkout + payments). Applies migrations up to 0016 only, so it does not
 * depend on later migrations being written in parallel. Proves the RLS design in README section 6.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDbContext, applyMigrations, assertTenantTablesProtected, listRlsExceptions, loadMigrations, narrowContext } from "@outlet/db";
import type { DbContext, Queryable, SqlClient } from "@outlet/db";
import { asRole, bootstrapTestRoles } from "@outlet/db/testing";
import type { DbRole } from "@outlet/db";
import { ORDER_GROUP_STATES, PAYMENT_INTENT_STATES, SELLER_ORDER_STATES } from "@outlet/orders";
import { PAYMENT_METHODS } from "../src/index.js";

const M = "EG";
const U_A = "01900000-0000-7000-8000-00000000000a";
const U_B = "01900000-0000-7000-8000-00000000000b";
const S_A = "01900000-0000-7000-8000-0000000000a1";
const S_B = "01900000-0000-7000-8000-0000000000b1";
const G_A = "01900000-0000-7000-8000-0000000001a0";
const G_B = "01900000-0000-7000-8000-0000000001b0";
const SO_AA = "01900000-0000-7000-8000-0000000002aa"; // shopper A, store A
const SO_AB = "01900000-0000-7000-8000-0000000002ab"; // shopper A, store B
const SO_BB = "01900000-0000-7000-8000-0000000002bb"; // shopper B, store B
const PI_A = "01900000-0000-7000-8000-0000000003a0";
const SKU = "01900000-0000-7000-8000-000000000500";
const PROD = "01900000-0000-7000-8000-000000000600";

let db: PGlite;
let client: SqlClient;

const run = <T>(role: DbRole, ctx: DbContext, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
  asRole(client, role, async (tx) => {
    await applyDbContext(tx, ctx);
    return fn(tx);
  });
const ids = async (tx: Queryable, sql: string, params: unknown[] = []): Promise<string[]> =>
  (await tx.query<{ id: string }>(sql, params)).rows.map((r) => r.id).sort();

const group = (id: string, user: string, status = "PENDING_PAYMENT", expires = "2000-01-01T00:00:00Z"): string =>
  `INSERT INTO checkout_sessions (id, user_id, market_id, currency, quote, quote_hash, payment_method, price_lock_expires_at)
     VALUES ('${id}', '${user}', '${M}', 'EGP', '{}', decode(repeat('ab', 32), 'hex'), 'card', now());
   INSERT INTO order_groups (id, user_id, market_id, currency, status, funds_flow, checkout_session_id, idempotency_key, payment_method,
     items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor, placed_at, payment_expires_at)
     VALUES ('${id}', '${user}', '${M}', 'EGP', '${status}', 'psp_split', '${id}', gen_random_uuid(), 'card', 10000, 600, 74, 1302, 10600, now(), '${expires}');`;
const sellerOrder = (id: string, g: string, store: string, user: string): string =>
  `INSERT INTO seller_orders (id, order_group_id, store_id, user_id, market_id, currency, status, funds_flow, items_subtotal_minor, shipping_minor,
     shipping_vat_minor, vat_minor, total_minor, commission_bp_snapshot, commission_minor, commission_vat_minor, seller_net_minor)
     VALUES ('${id}', '${g}', '${store}', '${user}', '${M}', 'EGP', 'PENDING_PAYMENT', 'psp_split', 5000, 300, 37, 651, 5300, 1500, 750, 105, 4145);
   INSERT INTO order_lines (id, seller_order_id, order_group_id, store_id, user_id, market_id, sku_id, product_id, title_ar_snapshot,
     condition_grade_snapshot, qty, unit_price_minor, currency, tax_category, vat_rate_bp, vat_minor, claim_type_snapshot)
     VALUES ('${id}', '${id}', '${g}', '${store}', '${user}', '${M}', '${SKU}', '${PROD}', 'فستان', 'new_with_tags', 1, 5000, 'EGP', 'standard', 1400, 614, 'plain');`;

beforeAll(async () => {
  db = new PGlite();
  await bootstrapTestRoles(db);
  const upTo16 = (await loadMigrations()).filter((m) => m.name <= "0016_zzz");
  expect(upTo16.at(-1)?.name).toBe("0016_orders_checkout");
  await applyMigrations(db, upTo16);
  /* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature */
  client = {
    query: async <R extends object>(sql: string, params?: readonly unknown[]) => ({ rows: (await db.query<R>(sql, params ? [...params] : [])).rows }),
    transaction: <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> =>
      db.transaction((t) => fn({ query: async <R extends object>(sql: string, params?: readonly unknown[]) => ({ rows: (await t.query<R>(sql, params ? [...params] : [])).rows }) })),
  };
  /* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */
  // Seed as the superuser with FK triggers off (catalog/users rows are irrelevant to the policies under test).
  await db.exec(`SET session_replication_role = replica;
    ${group(G_A, U_A)} ${group(G_B, U_B, "PAID", "2999-01-01T00:00:00Z")}
    ${sellerOrder(SO_AA, G_A, S_A, U_A)} ${sellerOrder(SO_AB, G_A, S_B, U_A)} ${sellerOrder(SO_BB, G_B, S_B, U_B)}
    INSERT INTO payment_intents (id, order_group_id, user_id, market_id, provider, provider_ref, method, amount_minor, currency, status)
      VALUES ('${PI_A}', '${G_A}', '${U_A}', '${M}', 'fake', 'psp-ref-a', 'card', 10600, 'EGP', 'REQUIRES_ACTION');
    SET session_replication_role = origin;`);
}, 120_000);
afterAll(async () => {
  await db.close();
});

describe("0016 schema", () => {
  it("passes the unchanged RLS audit and adds exactly the reviewed exception policies", async () => {
    await expect(assertTenantTablesProtected(client)).resolves.toBeDefined();
    const mine = (await listRlsExceptions(client)).filter((e) => /^(order_groups|payment_intents|payment_events_raw)$/.test(e.table) || /payments_webhook|checkout_expiry/.test(e.policy));
    expect(mine).toEqual([
      { table: "order_groups", policy: "order_groups__worker_checkout_expiry", role: "outlet_worker", cmd: "select" },
      { table: "outbox_events", policy: "outbox_events__worker_checkout_expiry", role: "outlet_worker", cmd: "insert" },
      { table: "outbox_events", policy: "outbox_events__worker_payments_webhook", role: "outlet_worker", cmd: "insert" },
      { table: "payment_events_raw", policy: "payment_events_raw__worker_payments_webhook", role: "outlet_worker", cmd: "all" },
      { table: "payment_events_raw", policy: "payment_events_raw__worker_privacy_retention_select", role: "outlet_worker", cmd: "select" },
      { table: "payment_events_raw", policy: "payment_events_raw__worker_privacy_retention_update", role: "outlet_worker", cmd: "update" },
      { table: "payment_intents", policy: "payment_intents__worker_payments_webhook", role: "outlet_worker", cmd: "select" },
    ]);
  });

  it("status and method CHECK lists equal the domain machines", async () => {
    const def = async (table: string, col: string): Promise<string[]> => {
      const r = await db.query<{ d: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS d FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%(' || $2 || ' = ANY%'`,
        [table, col],
      );
      return [...(r.rows[0]?.d ?? "").matchAll(/'([A-Za-z_]+)'::text/g)].map((x) => x[1] ?? "").sort();
    };
    expect(await def("order_groups", "status")).toEqual([...ORDER_GROUP_STATES].sort());
    expect(await def("seller_orders", "status")).toEqual([...SELLER_ORDER_STATES].sort());
    expect(await def("payment_intents", "status")).toEqual([...PAYMENT_INTENT_STATES].sort());
    expect(await def("payment_intents", "method")).toEqual([...PAYMENT_METHODS].sort());
  });

  it("shopper isolation: A sees only A's group, seller orders and lines; B's group id is not found", async () => {
    await run("outlet_app", { kind: "user", marketId: M, userId: U_A }, async (tx) => {
      expect(await ids(tx, "SELECT id FROM order_groups")).toEqual([G_A]);
      expect(await ids(tx, "SELECT id FROM seller_orders")).toEqual([SO_AA, SO_AB]);
      expect(await ids(tx, "SELECT id FROM order_lines")).toEqual([SO_AA, SO_AB]);
      expect(await ids(tx, "SELECT id FROM order_groups WHERE id = $1", [G_B])).toEqual([]);
      expect(await ids(tx, "SELECT id FROM payment_intents")).toEqual([PI_A]);
    });
    await run("outlet_app", { kind: "user", marketId: M, userId: U_B }, async (tx) => {
      expect(await ids(tx, "SELECT id FROM payment_intents")).toEqual([]);
      expect(await ids(tx, "SELECT id FROM seller_orders")).toEqual([SO_BB]);
    });
  });

  it("seller isolation: store A sees only its seller order and lines, never order groups or another store's orders", async () => {
    await run("outlet_app", { kind: "store", marketId: M, storeId: S_A }, async (tx) => {
      expect(await ids(tx, "SELECT id FROM seller_orders")).toEqual([SO_AA]);
      expect(await ids(tx, "SELECT id FROM order_lines")).toEqual([SO_AA]);
      expect(await ids(tx, "SELECT id FROM order_groups")).toEqual([]);
      expect(await ids(tx, "SELECT id FROM seller_orders WHERE id = $1", [SO_BB])).toEqual([]);
    });
  });

  it("a store context that carries the staff member's user id does not open that user's orders at other stores", async () => {
    await run("outlet_app", { kind: "store", marketId: M, storeId: S_A, userId: U_A }, async (tx) => {
      expect(await ids(tx, "SELECT id FROM seller_orders")).toEqual([SO_AA]);
    });
  });

  it("another market sees nothing even with the right user", async () => {
    await run("outlet_app", { kind: "user", marketId: "AE", userId: U_A }, async (tx) => {
      expect(await ids(tx, "SELECT id FROM seller_orders")).toEqual([]);
    });
  });

  it("outlet_app: raw webhooks are unreadable, money columns are write-once, nothing is deletable", async () => {
    await expect(run("outlet_app", { kind: "user", marketId: M, userId: U_A }, (tx) => tx.query("SELECT 1 FROM payment_events_raw"))).rejects.toThrow(/permission denied/);
    await expect(run("outlet_app", { kind: "user", marketId: M, userId: U_A }, (tx) => tx.query("UPDATE order_groups SET total_minor = 1 WHERE id = $1", [G_A]))).rejects.toThrow(/permission denied/);
    await expect(run("outlet_app", { kind: "store", marketId: M, storeId: S_A }, (tx) => tx.query("UPDATE seller_orders SET seller_net_minor = 1 WHERE id = $1", [SO_AA]))).rejects.toThrow(/permission denied/);
    await expect(run("outlet_app", { kind: "user", marketId: M, userId: U_A }, (tx) => tx.query("DELETE FROM order_lines WHERE id = $1", [SO_AA]))).rejects.toThrow(/permission denied/);
  });

  it("worker payments.webhook: resolves the intent without a user, reads orders only after narrowing", async () => {
    const act = run("outlet_worker", { kind: "worker", marketId: M, job: "payments.webhook" }, async (tx) => {
      const pi = (await tx.query<{ user_id: string }>("SELECT user_id FROM payment_intents WHERE provider = 'fake' AND provider_ref = 'psp-ref-a'")).rows[0];
      expect(pi?.user_id).toBe(U_A);
      expect(await ids(tx, "SELECT id FROM order_groups")).toEqual([]);
      expect(await ids(tx, "SELECT id FROM seller_orders")).toEqual([]);
      await narrowContext(tx, { userId: U_A });
      expect(await ids(tx, "SELECT id FROM order_groups")).toEqual([G_A]);
      expect(await ids(tx, "SELECT id FROM seller_orders")).toEqual([SO_AA, SO_AB]);
      expect(await ids(tx, "UPDATE order_groups SET status = 'PAID', paid_at = now() WHERE id = $1 RETURNING id", [G_A])).toEqual([G_A]);
      throw new Error("rollback-sentinel");
    });
    await expect(act).rejects.toThrow("rollback-sentinel");
    await run("outlet_worker", { kind: "worker", marketId: M, job: "outbox.relay" }, async (tx) => {
      expect(await ids(tx, "SELECT id FROM payment_intents")).toEqual([]);
    });
  });

  it("worker checkout.expiry sees only expired pending groups", async () => {
    await run("outlet_worker", { kind: "worker", marketId: M, job: "checkout.expiry" }, async (tx) => {
      expect(await ids(tx, "SELECT id FROM order_groups")).toEqual([G_A]);
    });
  });

  it("CHECKs: no verified claim without a higher VRP; group totals must add up", async () => {
    await expect(
      db.exec(`SET session_replication_role = replica;
        INSERT INTO order_lines (id, seller_order_id, order_group_id, store_id, user_id, market_id, sku_id, product_id, title_ar_snapshot,
          condition_grade_snapshot, qty, unit_price_minor, currency, tax_category, vat_rate_bp, vat_minor, claim_type_snapshot, vrp_minor_snapshot)
        VALUES (gen_random_uuid(), '${SO_AA}', '${G_A}', '${S_A}', '${U_A}', '${M}', '${SKU}', '${PROD}', 'x', 'new_with_tags', 1, 5000, 'EGP', 'standard', 1400, 614, 'verified_discount', 5000);`),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.exec(`SET session_replication_role = replica; INSERT INTO checkout_sessions (id, user_id, market_id, currency, quote, quote_hash, payment_method, price_lock_expires_at)
          VALUES ('01900000-0000-7000-8000-0000000009ff', '${U_A}', '${M}', 'EGP', '{}', decode(repeat('ab', 32), 'hex'), 'card', now());
        INSERT INTO order_groups (id, user_id, market_id, currency, status, funds_flow, checkout_session_id, idempotency_key, payment_method,
          items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor, placed_at)
        VALUES (gen_random_uuid(), '${U_A}', '${M}', 'EGP', 'PENDING_PAYMENT', 'psp_split', '01900000-0000-7000-8000-0000000009ff', gen_random_uuid(), 'card', 100, 0, 0, 0, 999, now());`),
    ).rejects.toThrow(/check constraint/);
    await db.exec("SET session_replication_role = origin");
  });
});
