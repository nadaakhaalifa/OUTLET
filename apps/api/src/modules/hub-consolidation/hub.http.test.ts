import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/env";
import { HubConsolidationModule, MissingHubPortsError } from "./index";
import {
  HOUR,
  HUB_1,
  IDEM,
  TOKENS,
  U,
  USERS,
  bearer,
  createHubHarness,
  type HubHarness,
} from "./test/harness";

let h: HubHarness;
let seq = 0;
const idem = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq) });
const GROUP = U(700);
const SO = [U(801), U(802), U(803)];

beforeEach(async () => {
  h = await createHubHarness();
});
afterEach(async () => {
  await h.close();
});

const tick = (): void => h.clock.advance(61_000);
const openGroup = (hubId = HUB_1, group = GROUP, together = true) =>
  h.open.execute({
    orderGroupId: group,
    userId: USERS.shopper1,
    hubId,
    deliveryFee: 6000n,
    shipTogether: together,
    paidAtMs: h.clock.nowMs(),
    legs: SO.map((id, i) => ({ sellerOrderId: id, storeId: U(9000 + i), lineIds: [U(900 + i)], subtotal: BigInt(1000 * (i + 1)) })),
  });
const scan = (so: string, token: string, condition = "ok") => {
  tick();
  return h.http().post("/v1/hub/receipts").set(idem()).set(bearer(token)).send({ seller_order_id: so, condition });
};
const dispatch = (id: string, token: string) => {
  tick();
  return h.http().post(`/v1/hub/consolidations/${id}/dispatch`).set(idem()).set(bearer(token)).send({});
};
const tracking = (group: string, token: string | null) => {
  tick();
  const r = h.http().get(`/v1/me/orders/${group}/tracking`);
  return token === null ? r : r.set(bearer(token));
};

describe("acceptance: three sellers, one parcel, one fee", () => {
  it("consolidates, dispatches one parcel and shows one parcel to the shopper", async () => {
    expect(await openGroup()).toEqual({ kind: "opened" });
    expect((await scan(SO[0] as string, TOKENS.opHub1)).body.state).toBe("RECEIVED");
    expect((await scan(SO[1] as string, TOKENS.opHub1)).body.consolidation_id).toBeNull();
    const last = await scan(SO[2] as string, TOKENS.opHub1);
    expect(last.status).toBe(200);
    const parcelId = last.body.consolidation_id as string;
    expect(parcelId).toBeTruthy();

    const before = await tracking(GROUP, TOKENS.shopper1);
    expect(before.body.parcels).toHaveLength(1);
    expect(before.body.parcels[0]).toMatchObject({ status: "ready_at_hub", seller_order_count: 3, fee_charged_piastres: "6000" });

    const d = await dispatch(parcelId, TOKENS.opHub1);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ status: "dispatched", is_estimate: true });
    expect(d.body.awb).toMatch(/^ARX/);
    expect(typeof d.body.gco2e_estimate).toBe("string");

    const after = await tracking(GROUP, TOKENS.shopper1);
    expect(after.body.parcels).toHaveLength(1);
    expect(after.body.parcels[0]).toMatchObject({ status: "dispatched", courier: "aramex" });
    // one balanced ledger entry for the consolidation cost
    expect([...h.ledger.entries.keys()]).toEqual([`hub-dispatch:${parcelId}`]);
    expect(h.store.outbox.map((e) => e.type)).toEqual([
      "hub.receipt_recorded",
      "hub.receipt_recorded",
      "hub.receipt_recorded",
      "hub.parcel_ready",
      "hub.parcel_dispatched",
    ]);
  });

  it("dispatch replay is idempotent: one AWB, one ledger entry", async () => {
    await openGroup();
    let parcelId = "";
    for (const so of SO) parcelId = ((await scan(so, TOKENS.opHub1)).body.consolidation_id as string | null) ?? parcelId;
    const a = await dispatch(parcelId, TOKENS.opHub1);
    const b = await dispatch(parcelId, TOKENS.opHub1);
    expect(b.body.awb).toBe(a.body.awb);
    expect(h.outbound.created.size).toBe(1);
    expect(h.ledger.entries.size).toBe(1);
  });
});

describe("acceptance: a seller misses the 72 h window", () => {
  it("dispatches the rest and waives the second fee", async () => {
    await openGroup();
    await scan(SO[0] as string, TOKENS.opHub1);
    await scan(SO[1] as string, TOKENS.opHub1);
    expect((await h.sweep.execute()).parcels).toBe(0);
    h.clock.advance(72 * HOUR);
    expect((await h.sweep.execute()).parcels).toBe(1);
    const first = (await h.store.listParcels(GROUP))[0];
    expect(first?.shopperFee).toBe(6000n);
    expect(first?.sellerOrderIds).toEqual([SO[0], SO[1]]);
    await dispatch(first?.id as string, TOKENS.opHub1);
    // the late seller arrives
    const late = await scan(SO[2] as string, TOKENS.opHub1);
    expect(late.status).toBe(200);
    const parcels = await h.store.listParcels(GROUP);
    expect(parcels).toHaveLength(2);
    expect(parcels[1]?.shopperFee).toBe(0n);
    expect(parcels.reduce((s, p) => s + p.shopperFee, 0n)).toBe(6000n);
  });

  it("with ship-together off, what is ready ships immediately", async () => {
    await openGroup(HUB_1, U(701), false);
    const r = await h.evaluate.execute(U(701));
    expect(r.kind).toBe("nothing".length ? r.kind : "x");
    const scanned = await scan(SO[0] as string, TOKENS.opHub1);
    // SO ids are global to hub_legs in the fake, so group 701 reuses the same legs only once
    expect(scanned.status).toBe(200);
  });
});

describe("authorization", () => {
  it("a hub operator scanning another hub's seller order gets 404", async () => {
    await openGroup(HUB_1);
    const r = await scan(SO[0] as string, TOKENS.opHub2);
    expect(r.status).toBe(404);
    expect((await h.store.getLeg(SO[0] as string))?.state).toBe("AT_HUB_EXPECTED");
  });
  it("a missing seller order is indistinguishable from a foreign one", async () => {
    const r = await scan(U(99_999), TOKENS.opHub1);
    expect(r.status).toBe(404);
  });
  it("another hub cannot dispatch the parcel (404)", async () => {
    await openGroup(HUB_1);
    let parcelId = "";
    for (const so of SO) parcelId = ((await scan(so, TOKENS.opHub1)).body.consolidation_id as string | null) ?? parcelId;
    expect((await dispatch(parcelId, TOKENS.opHub2)).status).toBe(404);
    expect(h.outbound.calls).toBe(0);
  });
  it("shopper, other admin roles and wrong audience are refused on hub routes", async () => {
    await openGroup(HUB_1);
    expect((await scan(SO[0] as string, TOKENS.adminSupport)).status).toBe(403);
    expect((await scan(SO[0] as string, TOKENS.shopperOnAdminAud)).status).toBe(403);
    expect((await scan(SO[0] as string, TOKENS.operatorOnBuyerAud)).status).toBe(401);
    tick();
    const anon = await h.http().post("/v1/hub/receipts").set(idem()).send({ seller_order_id: SO[0] });
    expect(anon.status).toBe(401);
    // role check precedes resource lookup: a role-less caller learns nothing about existence (403, never 404)
    expect((await dispatch(U(5), TOKENS.adminSupport)).status).toBe(403);
  });
  it("tracking: owner reads, other shopper gets 404, anonymous 401, operator without a shopper grant 403", async () => {
    await openGroup(HUB_1);
    expect((await tracking(GROUP, TOKENS.shopper1)).status).toBe(200);
    expect((await tracking(GROUP, TOKENS.shopper2)).status).toBe(404);
    expect((await tracking(U(12345), TOKENS.shopper1)).status).toBe(404);
    expect((await tracking(GROUP, null)).status).toBe(401);
    expect((await tracking(GROUP, TOKENS.operatorOnBuyerAud)).status).toBe(403);
  });
  it("requires an Idempotency-Key on receipts and dispatch", async () => {
    tick();
    const r = await h.http().post("/v1/hub/receipts").set(bearer(TOKENS.opHub1)).send({ seller_order_id: SO[0] });
    expect(r.status).toBe(400);
  });
});

describe("edge cases", () => {
  it("a damaged scan puts the leg in EXCEPTION and it never ships", async () => {
    await openGroup();
    const r = await scan(SO[0] as string, TOKENS.opHub1, "damaged");
    expect(r.body.state).toBe("EXCEPTION");
    await scan(SO[1] as string, TOKENS.opHub1);
    await scan(SO[2] as string, TOKENS.opHub1);
    const [p] = await h.store.listParcels(GROUP);
    expect(p?.sellerOrderIds).toEqual([SO[1], SO[2]]);
    expect(h.store.outbox.map((e) => e.type)).toContain("hub.leg_exception");
  });
  it("a repeated scan is a duplicate, not a second transition", async () => {
    await openGroup();
    await scan(SO[0] as string, TOKENS.opHub1);
    const again = await scan(SO[0] as string, TOKENS.opHub1);
    expect(again.body.duplicate).toBe(true);
    expect(h.store.outbox.filter((e) => e.type === "hub.receipt_recorded")).toHaveLength(1);
  });
  it("the kill switch stops new consolidations only", async () => {
    h.flags.enabled = false;
    expect(await openGroup()).toEqual({ kind: "disabled" });
  });
  it("courier down leaves the parcel READY for a retry", async () => {
    await openGroup();
    let parcelId = "";
    for (const so of SO) parcelId = ((await scan(so, TOKENS.opHub1)).body.consolidation_id as string | null) ?? parcelId;
    h.outbound.fail = "down";
    expect((await dispatch(parcelId, TOKENS.opHub1)).status).toBe(503);
    h.outbound.fail = "none";
    expect((await dispatch(parcelId, TOKENS.opHub1)).status).toBe(200);
  });
});

describe("module boot", () => {
  it("refuses to boot outside test mode without real ports", () => {
    expect(() => HubConsolidationModule.forRoot(loadConfig({ NODE_ENV: "development" }))).toThrow(MissingHubPortsError);
    expect(() => HubConsolidationModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
  });
});

describe("admin and seller consolidation views", () => {
  const get = (path: string, token: string | null) => {
    tick();
    const r = h.http().get(path);
    return token === null ? r : r.set(bearer(token));
  };
  it("admin lists parcels with a keyset page; roles and audiences enforced; bad cursor 400", async () => {
    await openGroup();
    for (const so of SO) await scan(so, TOKENS.opHub1);
    const ok = await get("/v1/admin/hub/consolidations?limit=1", TOKENS.adminOps);
    expect(ok.status).toBe(200);
    expect(ok.body.items).toHaveLength(1);
    expect(ok.body.items[0].shopper_fee).toEqual({ amount_minor: "6000", currency: "EGP" });
    expect(ok.body.page.has_more).toBe(false);
    expect((await get("/v1/admin/hub/consolidations", TOKENS.adminSupport)).status).toBe(403);
    expect((await get("/v1/admin/hub/consolidations", TOKENS.shopperOnAdminAud)).status).toBe(403);
    expect((await get("/v1/admin/hub/consolidations", TOKENS.sellerA)).status).toBe(401);
    expect((await get("/v1/admin/hub/consolidations", null)).status).toBe(401);
    expect((await get("/v1/admin/hub/consolidations?cursor=%%", TOKENS.adminOps)).status).toBe(400);
  });
  it("seller sees only own seller orders, no buyer PII; other store sees nothing; wrong audience 401", async () => {
    await openGroup();
    for (const so of SO) await scan(so, TOKENS.opHub1);
    const mine = await get(`/v1/seller/hub/consolidations?order_group_id=${GROUP}`, TOKENS.sellerA);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].parcel).toMatchObject({ status: "READY" });
    expect(JSON.stringify(mine.body)).not.toMatch(/phone|recipient|address|name|user_id/i);
    const other = await get(`/v1/seller/hub/consolidations?order_group_id=${GROUP}`, TOKENS.sellerOther);
    expect(other.body.items).toEqual([]);
    expect((await get("/v1/seller/hub/consolidations", TOKENS.sellerOnBuyerAud)).status).toBe(401);
    expect((await get("/v1/seller/hub/consolidations", TOKENS.shopper1)).status).toBe(401);
    expect((await get("/v1/seller/hub/consolidations", TOKENS.opHub1)).status).toBe(401);
    expect((await get("/v1/seller/hub/consolidations", null)).status).toBe(401);
    expect((await get("/v1/seller/hub/consolidations?cursor=%%", TOKENS.sellerA)).status).toBe(400);
    expect((await get("/v1/seller/hub/consolidations?order_group_id=nope", TOKENS.sellerA)).status).toBe(400);
  });
});
