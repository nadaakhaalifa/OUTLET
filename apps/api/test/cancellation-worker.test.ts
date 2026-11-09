import { SELLER_ORDER_CANCELLED_EVENT, SELLER_ORDER_REJECTED_EVENT } from "@outlet/checkout";
import { brandClient } from "@outlet/db";
import { describe, expect, it } from "vitest";
import { financeRefundHandlers } from "../src/worker-consumers.js";

const worker = brandClient<"outlet_worker">({ query: () => Promise.reject(new Error("db")), transaction: () => Promise.reject(new Error("db")) });

describe("finance.refunds dispatch table", () => {
  it("routes seller_order.cancelled and seller_order.rejected to the cancellation refund consumer", () => {
    const h = financeRefundHandlers(worker, "eg", { createForCancellation: () => Promise.resolve([]) });
    expect([...h.keys()].sort()).toEqual([SELLER_ORDER_CANCELLED_EVENT, SELLER_ORDER_REJECTED_EVENT].sort());
  });
  it("hands the event to the consumer (inbox lookup runs on the worker client)", async () => {
    const h = financeRefundHandlers(worker, "eg", { createForCancellation: () => Promise.resolve([]) });
    await expect(h.get(SELLER_ORDER_CANCELLED_EVENT)?.({ id: "e1", type: SELLER_ORDER_CANCELLED_EVENT, payload: {} })).rejects.toThrow("db");
  });
});

describe("promotionsSettleHandlers", () => {
  it("routes promotions.settle_requested to the settle consumer and confirms the vouchers once", async () => {
    const { promotionsSettleHandlers } = await import("../src/worker-consumers.js");
    const U = "018f0000-0000-7000-8000-000000000001";
    const G = "018f0000-0000-7000-8000-000000000002";
    const confirmed: string[] = [];
    const promotions = {
      confirm: (userId: string, groupId: string) => { confirmed.push(`${userId}:${groupId}`); return Promise.resolve(); },
    } as unknown as import("@outlet/checkout").PromotionsPort;
    const calls: string[] = [];
    const q = (sql: string) => { calls.push(sql); const rows = sql.startsWith("INSERT") ? [{ message_id: "evt-1" }] : []; return Promise.resolve({ rows, rowCount: rows.length }); };
    const worker = {
      query: q,
      transaction: (fn: (tx: { query: typeof q }) => Promise<unknown>) => fn({ query: q }),
    } as unknown as Parameters<typeof promotionsSettleHandlers>[0];
    const h = promotionsSettleHandlers(worker, promotions);
    expect([...h.keys()]).toEqual(["promotions.settle_requested"]);
    const handler = h.get("promotions.settle_requested");
    expect(handler).toBeDefined();
    await handler?.({ id: "evt-1", type: "promotions.settle_requested", payload: { user_id: U, order_group_id: G } });
    expect(confirmed).toEqual([`${U}:${G}`]);
    expect(calls.some((s) => s.includes("inbox_processed"))).toBe(true);
  });
});
