import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, bearer } from "./harness.js";
import type { TestApp } from "./harness.js";
import { postEntry, seedMarch2025, seedPayout } from "./seller-finance-fakes.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const H = async (store: string, roles: readonly ("owner" | "finance" | "support" | "catalog" | "manager")[]): Promise<Record<string, string>> => {
  const { token } = await t.seller(store, roles);
  return { ...bearer(token), "x-store-id": store };
};
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- response shape is a caller-asserted test type
const get = async <T>(url: string, headers: Record<string, string>): Promise<{ status: number; body: T }> => {
  const r = await t.inject({ method: "GET", url, headers });
  return { status: r.statusCode, body: JSON.parse(r.body) as T };
};
interface Money { amount_minor: string; currency: string }
interface Balance { pending: Money; available: Money; total: Money; payouts: { scheduled: Money; held: Money; in_transit: Money; paid_to_date: Money } }
interface Statement {
  opening_balance: Money; closing_balance: Money; orders_count: number; orders_gross: Money; commission: Money; commission_vat: Money; orders_net: Money; refunds: Money;
  adjustments: Money; payouts: Money; net_change: Money; eta_invoice: { status: string; url: null };
}
const n = (m: Money): bigint => BigInt(m.amount_minor);

describe("seller finance: statement and balance math against a seeded ledger", () => {
  it("statement lines sum to the balance change and match the ledger projection", async () => {
    const h = await H(t.seed.storeA, ["finance"]);
    const before = (await get<Balance>("/v1/eg/seller/finance/balance", h)).body;
    await seedMarch2025(t.raw, t.seed, t.seed.storeA);
    // Store B has its own March activity that must never leak into A's figures.
    await seedMarch2025(t.raw, t.seed, t.seed.storeB);

    const r = await get<Statement>("/v1/eg/seller/finance/statements?month=2025-03", h);
    expect(r.status).toBe(200);
    const s = r.body;
    expect(n(s.opening_balance)).toBe(2000n);
    expect(n(s.orders_net)).toBe(8860n);
    expect(n(s.commission)).toBe(1000n);
    expect(n(s.commission_vat)).toBe(140n);
    expect(n(s.orders_gross)).toBe(10_000n);
    expect(s.orders_count).toBe(1);
    expect(n(s.refunds)).toBe(-1000n);
    expect(n(s.adjustments)).toBe(-300n);
    expect(n(s.payouts)).toBe(-5000n);
    expect(n(s.net_change)).toBe(n(s.orders_net) + n(s.refunds) + n(s.adjustments) + n(s.payouts));
    expect(n(s.closing_balance) - n(s.opening_balance)).toBe(n(s.net_change));
    expect(s.eta_invoice).toEqual({ status: "not_connected", url: null });

    // Balance change equals the sum of all statement lines (February's 2,000 + March's change).
    const after = (await get<Balance>("/v1/eg/seller/finance/balance", h)).body;
    expect(n(after.total) - n(before.total)).toBe(n(s.closing_balance));
    expect(n(after.pending) - n(before.pending)).toBe(2000n);
    expect(n(after.available) - n(before.available)).toBe(2560n);
    expect(after.pending.currency).toBe("EGP");
  });

  it("an empty month is all zeros, and a month before the first entry has no opening balance", async () => {
    const h = await H(t.seed.storeA, ["owner"]);
    const s = (await get<Statement>("/v1/eg/seller/finance/statements?month=2019-01", h)).body;
    expect([s.opening_balance, s.closing_balance, s.orders_net, s.refunds, s.adjustments, s.payouts, s.net_change].map(n)).toEqual([0n, 0n, 0n, 0n, 0n, 0n, 0n]);
    expect(s.orders_count).toBe(0);
  });

  it("rejects a malformed month (400) and a role without statement.read (403)", async () => {
    const h = await H(t.seed.storeA, ["finance"]);
    expect((await get("/v1/eg/seller/finance/statements?month=2025-13", h)).status).toBe(400);
    expect((await get("/v1/eg/seller/finance/statements", h)).status).toBe(400);
    expect((await get("/v1/eg/seller/finance/statements?month=2025-03", await H(t.seed.storeA, ["support"]))).status).toBe(403);
  });

  it("a month boundary follows the Cairo calendar (an entry at 22:30 UTC on 31 March belongs to April)", async () => {
    const store = t.seed.storeA;
    const h = await H(store, ["finance"]);
    await postEntry(t.raw, { kind: "order_recognised", occurredAt: "2023-03-31T22:30:00.000Z", refType: "order_group", refId: randomUUID(), postings: [{ leg: { account: "psp_clearing" }, amount: 700 }, { leg: { store, type: "seller_pending" }, amount: -700 }] });
    expect(n((await get<Statement>("/v1/eg/seller/finance/statements?month=2023-03", h)).body.orders_net)).toBe(0n);
    expect(n((await get<Statement>("/v1/eg/seller/finance/statements?month=2023-04", h)).body.orders_net)).toBe(700n);
  });
});

describe("seller finance: payouts", () => {
  it("lists own payouts newest first with a keyset cursor and a status filter, and shows lines in the detail", async () => {
    const h = await H(t.seed.storeA, ["finance"]);
    const a = await seedPayout(t.raw, t.seed, { storeId: t.seed.storeA, status: "SETTLED" });
    const b = await seedPayout(t.raw, t.seed, { storeId: t.seed.storeA, status: "ON_HOLD" });
    const foreign = await seedPayout(t.raw, t.seed, { storeId: t.seed.storeB, status: "SETTLED" });

    const page1 = await get<{ items: { id: string; status: string; net: Money }[]; next_cursor: string | null }>("/v1/eg/seller/finance/payouts?limit=1", h);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.next_cursor).not.toBeNull();
    const page2 = await get<{ items: { id: string }[]; next_cursor: string | null }>(`/v1/eg/seller/finance/payouts?limit=50&cursor=${page1.body.next_cursor ?? ""}`, h);
    const all = [...page1.body.items, ...page2.body.items].map((i) => i.id);
    expect(all).toContain(a.id);
    expect(all).toContain(b.id);
    expect(all).not.toContain(foreign.id);

    const held = await get<{ items: { id: string; status: string }[] }>("/v1/eg/seller/finance/payouts?status=ON_HOLD", h);
    expect(held.body.items.every((i) => i.status === "ON_HOLD")).toBe(true);
    expect(held.body.items.map((i) => i.id)).toContain(b.id);
    expect((await get("/v1/eg/seller/finance/payouts?status=BOGUS", h)).status).toBe(400);
    expect((await get("/v1/eg/seller/finance/payouts?cursor=!!!", h)).status).toBe(400);

    const d = await get<{ id: string; net: Money; lines: { kind: string; amount: Money; seller_order_id: string | null }[]; lines_truncated: boolean }>(`/v1/eg/seller/finance/payouts/${a.id}`, h);
    expect(d.status).toBe(200);
    expect(d.body.lines.map((l) => n(l.amount)).reduce((x, y) => x + y, 0n)).toBe(n(d.body.net));
    expect(d.body.lines.find((l) => l.kind === "order")?.seller_order_id).toBe(a.sellerOrderId);
    expect(d.body.lines_truncated).toBe(false);
    expect(Object.keys(d.body)).not.toContain("hold_reason");
  });

  it("balance payout totals follow the payout states", async () => {
    const h = await H(t.seed.storeA, ["owner"]);
    const before = (await get<Balance>("/v1/eg/seller/finance/balance", h)).body;
    await seedPayout(t.raw, t.seed, { storeId: t.seed.storeA, status: "SENT" });
    await seedPayout(t.raw, t.seed, { storeId: t.seed.storeA, status: "ON_HOLD" });
    await seedPayout(t.raw, t.seed, { storeId: t.seed.storeA, status: "SCHEDULED" });
    await seedPayout(t.raw, t.seed, { storeId: t.seed.storeB, status: "SENT" });
    const after = (await get<Balance>("/v1/eg/seller/finance/balance", h)).body;
    expect(n(after.payouts.in_transit) - n(before.payouts.in_transit)).toBe(5000n);
    expect(n(after.payouts.held) - n(before.payouts.held)).toBe(5000n);
    expect(n(after.payouts.scheduled) - n(before.payouts.scheduled)).toBe(5000n);
  });

  it("another store's payout is 404, an unknown id is 404, a non-uuid is 400, shopper and support are refused", async () => {
    const foreign = await seedPayout(t.raw, t.seed, { storeId: t.seed.storeB });
    const h = await H(t.seed.storeA, ["finance"]);
    expect((await get(`/v1/eg/seller/finance/payouts/${foreign.id}`, h)).status).toBe(404);
    expect((await get(`/v1/eg/seller/finance/payouts/${randomUUID()}`, h)).status).toBe(404);
    expect((await get("/v1/eg/seller/finance/payouts/not-a-uuid", h)).status).toBe(400);
    expect((await get("/v1/eg/seller/finance/balance", await H(t.seed.storeA, ["support"]))).status).toBe(403);
    expect((await get("/v1/eg/seller/finance/payouts", await H(t.seed.storeA, ["catalog"]))).status).toBe(403);
    const shopper = await t.mint({ amr: ["otp", "passkey"] });
    expect((await get("/v1/eg/seller/finance/balance", { ...bearer(shopper), "x-store-id": t.seed.storeA })).status).toBe(404);
  });
});
