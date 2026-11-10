import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RefundView, ReturnView } from "../src/index.js";
import { buildWorld, errCode } from "./fixtures.js";
import type { Order, World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

type Reason = Parameters<World["returns"]["request"]>[1]["reason"];
const requestReturn = async (userId: string, o: Order, reason: Reason = "changed_mind"): Promise<ReturnView> =>
  w.returns.request(userId, { items: [{ orderLineId: o.lineIds[0] ?? "", qty: 1 }], reason, method: "pickup", idempotencyKey: randomUUID() });
const acceptedRefund = async (): Promise<{ refund: RefundView; ret: ReturnView; storeId: string; userId: string }> => {
  const [storeId] = w.stores;
  const userId = await w.newUser();
  const o = await w.order({ userId, storeId, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
  const ret = await requestReturn(userId, o);
  const s = w.seller(storeId);
  await w.returns.receive(s, storeId, ret.id);
  await w.returns.inspect(s, storeId, ret.id, { result: "accepted" });
  const refund = await w.refunds.createForReturn(ret.id);
  if (refund === null) throw new Error("expected refund");
  return { refund, ret, storeId, userId };
};

describe("RefundService.createForReturn guards", () => {
  it("unknown return is not_found; malformed id is rejected before any query", async () => {
    expect(await errCode(w.refunds.createForReturn(randomUUID()))).toBe("not_found");
    await expect(w.refunds.createForReturn("not-a-uuid")).rejects.toThrow();
  });
  it("a return that is not ACCEPTED yet cannot be refunded", async () => {
    const [storeId] = w.stores;
    const userId = await w.newUser();
    const o = await w.order({ userId, storeId, lines: [{ price: 10_000n }], deliveredDaysAgo: 1 });
    const ret = await requestReturn(userId, o);
    expect(await errCode(w.refunds.createForReturn(ret.id))).toBe("invalid_state");
  });
  it("is idempotent: the second call is a replay of the same refund", async () => {
    const { refund, ret } = await acceptedRefund();
    const again = await w.refunds.createForReturn(ret.id);
    expect(again).toMatchObject({ id: refund.id, replayed: true });
  });
});

describe("RefundService approve / resolveManually / process authorization and state", () => {
  it("unknown refund is not_found for finance; the wrong role is forbidden before the lookup", async () => {
    const finance = w.admin(["finance"]);
    expect(await errCode(w.refunds.approve(finance, randomUUID()))).toBe("not_found");
    expect(await errCode(w.refunds.resolveManually(finance, randomUUID(), "BANK-REF-1"))).toBe("not_found");
    expect(await errCode(w.refunds.process(randomUUID()))).toBe("not_found");
    for (const roles of [["support"], ["ops"], []]) {
      expect(await errCode(w.refunds.approve(w.admin(roles), randomUUID()))).toBe("forbidden");
      expect(await errCode(w.refunds.resolveManually(w.admin(roles), randomUUID(), "BANK-REF-1"))).toBe("forbidden");
    }
  });
  it("a seller principal cannot approve or manually resolve a refund", async () => {
    const { refund, storeId } = await acceptedRefund();
    const seller = w.seller(storeId);
    expect(["forbidden", "not_found"]).toContain(await errCode(w.refunds.approve(seller, refund.id)));
    expect(["forbidden", "not_found"]).toContain(await errCode(w.refunds.resolveManually(seller, refund.id, "BANK-REF-1")));
  });
  it("a blank or oversized bank reference is rejected by validation before any lookup beyond the role check", async () => {
    const finance = w.admin(["finance"]);
    await expect(w.refunds.resolveManually(finance, randomUUID(), "   ")).rejects.toThrow();
    await expect(w.refunds.resolveManually(finance, randomUUID(), "x".repeat(101))).rejects.toThrow();
  });
  it("approving an already APPROVED refund and resolving a non-manual refund are invalid_state", async () => {
    const { refund } = await acceptedRefund();
    expect(refund.status).toBe("APPROVED");
    expect(await errCode(w.refunds.approve(w.admin(["finance"]), refund.id))).toBe("invalid_state");
    expect(await errCode(w.refunds.resolveManually(w.admin(["finance"]), refund.id, "BANK-REF-1"))).toBe("invalid_state");
    expect((await w.refunds.process(refund.id)).status).toBe("COMPLETED");
    expect(await errCode(w.refunds.resolveManually(w.admin(["finance"]), refund.id, "BANK-REF-1"))).toBe("invalid_state");
    expect((await w.refunds.process(refund.id)).status).toBe("COMPLETED"); // re-processing a completed refund is a no-op replay
  });
});

describe("InventoryRestock edge cases", () => {
  it("a sku with no inventory level is a silent no-op (nothing is invented), and non-restock decisions never touch stock", async () => {
    const { InventoryRestock } = await import("../src/index.js");
    const port = new InventoryRestock(w.app, "EG");
    const [storeId] = w.stores;
    const before = Number((await w.raw.query<{ n: string }>("SELECT count(*)::text AS n FROM inventory_levels")).rows[0]?.n);
    await expect(port.apply({ storeId, skuId: randomUUID(), qty: 1, decision: "restock", idempotencyKey: randomUUID() })).resolves.toBeUndefined();
    await expect(port.apply({ storeId, skuId: randomUUID(), qty: 1, decision: "write_off", idempotencyKey: randomUUID() })).resolves.toBeUndefined();
    const after = Number((await w.raw.query<{ n: string }>("SELECT count(*)::text AS n FROM inventory_levels")).rows[0]?.n);
    expect(after).toBe(before);
  });
});

describe("makeEnv defaults", () => {
  it("fills config, clock, id generator and outbox, and lets explicit values win", async () => {
    const { makeEnv, DEFAULT_CONFIG } = await import("../src/application/env.js");
    const stub = {} as never;
    const deps = { admin: stub, app: stub, worker: stub, marketId: "EG", policy: stub, evidence: stub, restock: stub, provider: stub, kill: stub };
    const env = makeEnv(deps);
    expect(env.config).toEqual(DEFAULT_CONFIG);
    expect(env.now()).toBeInstanceOf(Date);
    expect(env.newId()).not.toBe(env.newId());
    expect(env.outbox).toBeDefined();
    const fixed = new Date("2030-05-05T00:00:00Z");
    const o = makeEnv({ ...deps, now: () => fixed, newId: () => "id-fixed", config: { maxRefundAttempts: 2 } });
    expect(o.now()).toBe(fixed);
    expect(o.newId()).toBe("id-fixed");
    expect(o.config).toEqual({ ...DEFAULT_CONFIG, maxRefundAttempts: 2 });
  });
});
