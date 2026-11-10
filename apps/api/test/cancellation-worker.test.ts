import { SELLER_ORDER_CANCELLED_EVENT, SELLER_ORDER_REJECTED_EVENT } from "@outlet/checkout";
import { brandClient } from "@outlet/db";
import { describe, expect, it } from "vitest";
import { attentionHandlers, financeRefundHandlers, promotionsSettleHandlers } from "../src/worker-consumers.js";

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
  const U = "018f0000-0000-7000-8000-000000000001";
  const G = "018f0000-0000-7000-8000-000000000002";
  /** A worker client double that records every statement and the database context settings it ran under. */
  const recorder = () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const q = (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      const rows = sql.startsWith("INSERT INTO inbox_processed") ? [{ message_id: "evt" }] : [];
      return Promise.resolve({ rows, rowCount: rows.length });
    };
    const worker = brandClient<"outlet_worker">({ query: q, transaction: (fn: (tx: { query: typeof q }) => Promise<unknown>) => fn({ query: q }) } as never);
    return { calls, worker };
  };

  it("routes promotions.settle_requested to the settle consumer, confirms once, and binds the checkout.settle worker context", async () => {
    const confirmed: string[] = [];
    const { calls, worker: w } = recorder();
    const h = promotionsSettleHandlers(w, "eg", { confirm: (userId: string, groupId: string) => { confirmed.push(`${userId}:${groupId}`); return Promise.resolve(1); } });
    expect([...h.keys()]).toEqual(["promotions.settle_requested"]);
    expect(await h.get("promotions.settle_requested")?.({ id: "evt-1", type: "promotions.settle_requested", payload: { user_id: U, order_group_id: G } })).toBe("processed");
    expect(confirmed).toEqual([`${U}:${G}`]);
    expect(calls.some((c) => c.sql.includes("inbox_processed"))).toBe(true);
    expect(calls.some((c) => c.params.includes("checkout.settle"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("outbox_events"))).toBe(false);
  });

  it("parks a malformed payload: no confirm, an inbox row and a promotions.settle_attention event", async () => {
    const confirmed: string[] = [];
    const { calls, worker: w } = recorder();
    const h = promotionsSettleHandlers(w, "eg", { confirm: () => { confirmed.push("x"); return Promise.resolve(0); } });
    expect(await h.get("promotions.settle_requested")?.({ id: "evt-2", type: "promotions.settle_requested", payload: { order_group_id: G } })).toBe("processed");
    expect(confirmed).toEqual([]);
    expect(calls.some((c) => c.sql.startsWith("INSERT INTO inbox_processed"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("outbox_events") && c.params.includes("promotions.settle_attention"))).toBe(true);
  });
});

describe("attentionHandlers (ops.attention)", () => {
  it("routes the three attention events to one consumer and binds the ops.attention worker context", async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const q = (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return Promise.resolve({ rows: [], rowCount: 0 });
    };
    const w = brandClient<"outlet_worker">({ query: q, transaction: (fn: (tx: { query: typeof q }) => Promise<unknown>) => fn({ query: q }) } as never);
    const h = attentionHandlers(w, "eg");
    expect([...h.keys()].sort()).toEqual(["promotions.settle_attention", "refund.attention", "shipment.cancel_attention"]);
    // the inbox lookup finds nothing and the insert returns no row: the consumer reports a duplicate without touching attention_items
    expect(await h.get("refund.attention")?.({ id: "e1", type: "refund.attention", payload: {} })).toBe("duplicate");
    expect(calls.some((c) => c.params.includes("ops.attention"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("attention_items"))).toBe(false);
  });
});
