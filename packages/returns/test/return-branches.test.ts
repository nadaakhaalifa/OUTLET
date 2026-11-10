import { randomUUID } from "node:crypto";
import type { Principal } from "@outlet/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAY, buildWorld, errCode } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

const mk = (o: Parameters<World["order"]>[0]) => w.order(o);

describe("ReturnService.request guards", () => {
  it("the same order line twice in one request is refused", async () => {
    const [storeId] = w.stores;
    const u = await w.newUser();
    const o = await mk({ userId: u, storeId, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const line = o.lineIds[0] ?? "";
    expect(await errCode(w.returns.request(u, { items: [{ orderLineId: line, qty: 1 }, { orderLineId: line, qty: 1 }], reason: "changed_mind", method: "pickup", idempotencyKey: randomUUID() }))).toBe("nothing_to_return");
  });

  it("lines of two different seller orders cannot be returned together", async () => {
    const [a, b] = w.stores;
    const u = await w.newUser();
    const o1 = await mk({ userId: u, storeId: a, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const o2 = await mk({ userId: u, storeId: b, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    expect(await errCode(w.returns.request(u, { items: [{ orderLineId: o1.lineIds[0] ?? "", qty: 1 }, { orderLineId: o2.lineIds[0] ?? "", qty: 1 }], reason: "changed_mind", method: "pickup", idempotencyKey: randomUUID() }))).toBe("not_found");
  });

  it("a BNPL order cannot ask for store credit (the provider gets the money back), but may ask for the original method", async () => {
    const [storeId] = w.stores;
    const u = await w.newUser();
    const o = await mk({ userId: u, storeId, lines: [{ price: 10_000n }], deliveredDaysAgo: 1, method: "bnpl", bnplProvider: "valu" });
    const base = { items: [{ orderLineId: o.lineIds[0] ?? "", qty: 1 }], reason: "changed_mind" as const, method: "pickup" as const };
    expect(await errCode(w.returns.request(u, { ...base, refundChoice: "store_credit", idempotencyKey: randomUUID() }))).toBe("request_bnpl_provider_only");
    expect((await w.returns.request(u, { ...base, refundChoice: "original", idempotencyKey: randomUUID() })).status).toBe("APPROVED");
  });
});

describe("ReturnService seller steps", () => {
  const requested = async () => {
    const [storeId] = w.stores;
    const u = await w.newUser();
    const o = await mk({ userId: u, storeId, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const ret = await w.returns.request(u, { items: [{ orderLineId: o.lineIds[0] ?? "", qty: 1 }], reason: "changed_mind", method: "pickup", idempotencyKey: randomUUID() });
    return { storeId, u, o, ret };
  };
  const status = async (id: string): Promise<string> => (await w.raw.query<{ status: string }>("SELECT status FROM return_requests WHERE id = $1", [id])).rows[0]?.status ?? "";

  it("a parcel received after its pickup was scheduled goes through transit to RECEIVED and starts the inspection and refund clocks", async () => {
    const { storeId, ret } = await requested();
    const s = w.seller(storeId);
    expect((await w.returns.schedulePickup(s, storeId, ret.id)).status).toBe("PICKUP_SCHEDULED");
    const got = await w.returns.receive(s, storeId, ret.id);
    expect(got.status).toBe("RECEIVED");
    expect(await status(ret.id)).toBe("RECEIVED");
    const row = (await w.raw.query<{ inspection_due_at: Date; refund_due_at: Date }>("SELECT inspection_due_at, refund_due_at FROM return_requests WHERE id = $1", [ret.id])).rows[0];
    expect(row?.inspection_due_at.getTime()).toBeGreaterThan(w.clock.t);
    expect(row?.refund_due_at.getTime()).toBeGreaterThan(row?.inspection_due_at.getTime() ?? 0);
  });

  it("inspecting an item that is not part of the return is not found and records nothing", async () => {
    const { storeId, o, ret } = await requested();
    const s = w.seller(storeId);
    await w.returns.receive(s, storeId, ret.id);
    const other = await mk({ userId: await w.newUser(), storeId, lines: [{ price: 5_000n }], deliveredDaysAgo: 1 });
    expect(await errCode(w.returns.inspect(s, storeId, ret.id, { result: "accepted", items: [{ orderLineId: other.lineIds[0] ?? "", condition: "as_new", restock: "restock" }] }))).toBe("not_found");
    expect(await status(ret.id)).toBe("RECEIVED");
    expect((await w.raw.query("SELECT 1 FROM return_inspections WHERE return_request_id = $1", [ret.id])).rows).toHaveLength(0);
    expect(o.lineIds).toHaveLength(1);
  });

  it("a silent seller: only a return past its inspection deadline is auto-approved, once", async () => {
    const { storeId, ret } = await requested();
    const s = w.seller(storeId);
    await w.returns.receive(s, storeId, ret.id);
    expect(await w.returns.autoApproveDue()).not.toContain(ret.id);
    w.clock.t += 3 * DAY;
    try {
      expect(await w.returns.autoApproveDue()).toContain(ret.id);
      expect(await status(ret.id)).toBe("ACCEPTED");
      expect(await w.returns.autoApproveDue()).not.toContain(ret.id);
    } finally { w.clock.t -= 3 * DAY; }
  });

  it("a rejection nobody disputes closes after the grace period, not before", async () => {
    const { storeId, ret } = await requested();
    const s = w.seller(storeId);
    await w.returns.receive(s, storeId, ret.id);
    await w.returns.inspect(s, storeId, ret.id, { result: "rejected", reasonCode: "worn" });
    expect(await w.returns.closeRejected()).not.toContain(ret.id);
    w.clock.t += 15 * DAY;
    try {
      expect(await w.returns.closeRejected()).toContain(ret.id);
      expect(await status(ret.id)).toBe("CLOSED");
      expect(await w.returns.closeRejected()).not.toContain(ret.id);
    } finally { w.clock.t -= 15 * DAY; }
  });
});

describe("disputes", () => {
  it("an overdue dispute is flagged exactly once; a decision by an admin without a user id leaves the assignee empty; an unknown dispute is not found", async () => {
    const [storeId] = w.stores;
    const u = await w.newUser();
    const o = await mk({ userId: u, storeId, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const ret = await w.returns.request(u, { items: [{ orderLineId: o.lineIds[0] ?? "", qty: 1 }], reason: "changed_mind", method: "pickup", idempotencyKey: randomUUID() });
    const s = w.seller(storeId);
    await w.returns.receive(s, storeId, ret.id);
    await w.returns.inspect(s, storeId, ret.id, { result: "rejected", reasonCode: "worn" });
    const d = await w.returns.openDispute(u, ret.id, { reasonCode: "rejection_unjustified" });
    expect(await w.returns.flagDisputeSlaBreaches()).not.toContain(d.disputeId);
    w.clock.t += 10 * DAY;
    try {
      expect(await w.returns.flagDisputeSlaBreaches()).toContain(d.disputeId);
      expect(await w.returns.flagDisputeSlaBreaches()).not.toContain(d.disputeId);
    } finally { w.clock.t -= 10 * DAY; }
    const anon: Principal = { kind: "admin", marketId: "EG", roles: ["trust_safety"], scopes: [] };
    expect(await w.returns.resolveDispute(anon, d.disputeId, "shopper", "photos show it unused")).toBe("ACCEPTED");
    expect((await w.raw.query<{ assigned_staff_id: string | null; status: string }>("SELECT assigned_staff_id, status FROM disputes WHERE id = $1", [d.disputeId])).rows[0]).toEqual({ assigned_staff_id: null, status: "RESOLVED_SHOPPER" });
    expect(await errCode(w.returns.resolveDispute(w.admin(["trust_safety"]), randomUUID(), "seller", "x"))).toBe("not_found");
    expect(await errCode(w.returns.resolveDispute(w.admin(["support"]), d.disputeId, "seller", "x"))).toBe("forbidden");
  });
});
