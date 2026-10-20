import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createIdGenerator, nodeCsprng } from "../../../platform";
import { OrderCommands } from "../application/commands";
import type { OrderRepository } from "../domain/ports";
import {
  GROUP_1,
  GROUP_2,
  ORDER_A,
  ORDER_A2,
  ORDER_B,
  SHOPPER_A,
  SHOPPER_B,
  STAFF_A,
  STAFF_B,
  STORE_A,
  STORE_B,
  T0,
  kit,
  placeTwoStoreGroup,
  sellerScope,
  type Kit,
  type TestClock,
} from "./fixtures";

export interface OrderRepoContext {
  readonly repo: OrderRepository;
  readonly clock: TestClock;
  /** Makes the users exist where the store enforces the FK (Postgres); no-op in memory. */
  ensureUser(userId: string): Promise<void>;
  /** Types of every outbox event written so far, in order. */
  outboxTypes(): Promise<string[]>;
  /** Every outbox event written so far, in order, with its payload. */
  outboxEvents(): Promise<{ type: string; payload: Record<string, unknown> }[]>;
  /** Number of status history rows for an order. */
  historyCount(sellerOrderId: string): Promise<number>;
}

/** Behaviour every OrderRepository must have. Run against in-memory and Kysely/PGlite. */
export function describeOrderRepositoryContract(name: string, make: () => Promise<OrderRepoContext>): void {
  describe(`OrderRepository contract: ${name}`, () => {
    let c: OrderRepoContext;
    let k: Kit;
    beforeEach(async () => {
      c = await make();
      await c.ensureUser(SHOPPER_A);
      await c.ensureUser(SHOPPER_B);
      k = kit(c.repo, c.clock);
    });

    it("places a group once per idempotency key and writes nothing on a duplicate", async () => {
      expect(await placeTwoStoreGroup(k)).toEqual({ kind: "created", groupId: GROUP_1 });
      const before = (await c.outboxTypes()).length;
      expect(await placeTwoStoreGroup(k)).toEqual({ kind: "duplicate", groupId: GROUP_1 });
      expect((await c.outboxTypes()).length).toBe(before);
      expect(await c.outboxTypes()).toEqual(["seller_order.placed", "seller_order.placed"]);
    });

    it("stores exact bigint piastres and freezes accept_by = paid_at + 24h", async () => {
      await k.intake.placeOrder({
        groupId: GROUP_1,
        userId: SHOPPER_A,
        paidAtMs: T0,
        stores: [{ sellerOrderId: ORDER_A, storeId: STORE_A, unitPrice: { amount: 9_007_199_254_740_993n, currency: "EGP" } }],
      });
      const o = await c.repo.getSellerOrder(ORDER_A, { kind: "system" });
      expect(o?.subtotal.amount).toBe(9_007_199_254_740_993n);
      expect(o?.acceptByMs).toBe(T0 + 86_400_000);
      expect(o?.status).toBe("PAID");
      expect(o?.version).toBe(0);
    });

    it("COD orders are CONFIRMED_COD and the group follows", async () => {
      await placeTwoStoreGroup(k, { paymentMethod: "cod" });
      const g = await c.repo.getGroupForUser(GROUP_1, SHOPPER_A);
      expect(g?.status).toBe("CONFIRMED_COD");
      expect(g?.sellerOrders.map((o) => o.status)).toEqual(["CONFIRMED_COD", "CONFIRMED_COD"]);
    });

    it("shows a group to its owner only, without buyer contact data", async () => {
      await placeTwoStoreGroup(k);
      const g = await c.repo.getGroupForUser(GROUP_1, SHOPPER_A);
      expect(g?.sellerOrders).toHaveLength(2);
      expect(g?.sellerOrders.every((o) => o.buyer === null)).toBe(true);
      expect(await c.repo.getGroupForUser(GROUP_1, SHOPPER_B)).toBeNull();
      expect(await c.repo.groupOwner(GROUP_1)).toBe(SHOPPER_A);
      expect(await c.repo.groupOwner("not-a-uuid")).toBeNull();
    });

    it("lists a shopper's own groups with their seller orders and never another user's", async () => {
      await placeTwoStoreGroup(k);
      const mine = await c.repo.listGroupsForUser({ userId: SHOPPER_A, after: null, limit: 10 });
      expect(mine.items.map((g) => g.id)).toEqual([GROUP_1]);
      expect(mine.items[0]?.sellerOrders).toHaveLength(2);
      expect(mine.items[0]?.sellerOrders.every((o) => o.buyer === null)).toBe(true);
      expect(mine.next).toBeNull();
      expect((await c.repo.listGroupsForUser({ userId: SHOPPER_B, after: null, limit: 10 })).items).toEqual([]);
      expect((await c.repo.listGroupsForUser({ userId: "not-a-uuid", after: null, limit: 10 })).items).toEqual([]);
    });

    it("enforces tenant scope on reads: another store's order is invisible", async () => {
      await placeTwoStoreGroup(k);
      expect((await c.repo.getSellerOrder(ORDER_A, sellerScope(STAFF_A, STORE_A)))?.id).toBe(ORDER_A);
      expect(await c.repo.getSellerOrder(ORDER_A, sellerScope(STAFF_B, STORE_B))).toBeNull();
      expect(await c.repo.getSellerOrder(ORDER_A, { kind: "shopper", userId: SHOPPER_B })).toBeNull();
      const own = await c.repo.getSellerOrder(ORDER_A, { kind: "shopper", userId: SHOPPER_A });
      expect(own?.buyer).toBeNull();
      const seller = await c.repo.getSellerOrder(ORDER_A, sellerScope(STAFF_A, STORE_A));
      expect(seller?.buyer?.governorateCode).toBe("EG-C");
      expect(seller?.lines).toHaveLength(2);
    });

    it("lists only the requested and permitted stores, newest first, with keyset paging", async () => {
      await placeTwoStoreGroup(k);
      c.clock.advance(1_000);
      await k.intake.placeOrder({
        groupId: GROUP_2,
        userId: SHOPPER_B,
        paidAtMs: c.clock.nowMs(),
        stores: [{ sellerOrderId: ORDER_A2, storeId: STORE_A }],
      });
      const scope = sellerScope(STAFF_A, STORE_A);
      const p1 = await c.repo.listForStores({ scope, storeIds: [STORE_A], after: null, limit: 1 });
      expect(p1.items.map((o) => o.id)).toEqual([ORDER_A2]);
      expect(p1.next).not.toBeNull();
      const p2 = await c.repo.listForStores({ scope, storeIds: [STORE_A], after: p1.next, limit: 1 });
      expect(p2.items.map((o) => o.id)).toEqual([ORDER_A]);
      expect(p2.next).toBeNull();
      // asking for a store the scope does not hold yields nothing, even when named explicitly
      const foreign = await c.repo.listForStores({ scope, storeIds: [STORE_B], after: null, limit: 10 });
      expect(foreign.items).toEqual([]);
      const byStatus = await c.repo.listForStores({ scope, storeIds: [STORE_A], status: "ACCEPTED", after: null, limit: 10 });
      expect(byStatus.items).toEqual([]);
    });

    it("accept moves to ACCEPTED, freezes dispatch_by, writes history and one event, and starts the group", async () => {
      await placeTwoStoreGroup(k);
      c.clock.advance(60_000);
      const r = await k.commands.accept({
        sellerOrderId: ORDER_A,
        scope: sellerScope(STAFF_A, STORE_A),
        actorId: STAFF_A,
        idempotencyKey: "key-1",
      });
      expect(r.kind).toBe("ok");
      if (r.kind !== "ok") return;
      expect(r.order.status).toBe("ACCEPTED");
      expect(r.order.version).toBe(1);
      expect(r.order.acceptedAtMs).toBe(T0 + 60_000);
      expect(r.order.dispatchByMs).toBe(T0 + 60_000 + 172_800_000);
      expect(await c.historyCount(ORDER_A)).toBe(1);
      const types = await c.outboxTypes();
      expect(types.filter((t) => t === "seller_order.accepted")).toHaveLength(1);
      expect(types).toContain("order_group.fulfilling");
      expect((await c.repo.getGroupForUser(GROUP_1, SHOPPER_A))?.status).toBe("FULFILLING");
    });

    it("replays a command with the same key: same outcome, no second transition or event", async () => {
      await placeTwoStoreGroup(k);
      const args = { sellerOrderId: ORDER_A, scope: sellerScope(STAFF_A, STORE_A), actorId: STAFF_A, idempotencyKey: "same" };
      const first = await k.commands.accept(args);
      const eventsAfterFirst = (await c.outboxTypes()).length;
      const second = await k.commands.accept(args);
      expect(first.kind).toBe("ok");
      expect(second).toMatchObject({ kind: "ok", replayed: true });
      expect((await c.outboxTypes()).length).toBe(eventsAfterFirst);
      expect(await c.historyCount(ORDER_A)).toBe(1);
    });

    it("a different key on an already accepted order is an invalid transition", async () => {
      await placeTwoStoreGroup(k);
      const s = sellerScope(STAFF_A, STORE_A);
      await k.commands.accept({ sellerOrderId: ORDER_A, scope: s, actorId: STAFF_A, idempotencyKey: "k1" });
      const r = await k.commands.accept({ sellerOrderId: ORDER_A, scope: s, actorId: STAFF_A, idempotencyKey: "k2" });
      expect(r.kind).toBe("invalid_transition");
    });

    it("refuses accept after the SLA and the sweep cancels with both events", async () => {
      await placeTwoStoreGroup(k);
      c.clock.advance(86_400_000);
      const s = sellerScope(STAFF_A, STORE_A);
      expect((await k.commands.accept({ sellerOrderId: ORDER_A, scope: s, actorId: STAFF_A, idempotencyKey: "late" })).kind).toBe(
        "accept_window_elapsed",
      );
      expect(await c.repo.findAcceptSlaExpired(c.clock.nowMs(), 10)).toEqual([ORDER_A, ORDER_B].sort());
      const swept = await k.commands.expireUnaccepted(10);
      expect(swept).toEqual({ cancelled: 2, skipped: 0, failed: 0 });
      const o = await c.repo.getSellerOrder(ORDER_A, { kind: "system" });
      expect(o).toMatchObject({ status: "CANCELLED", cancelInitiator: "SYSTEM_TIMEOUT", cancelReason: "accept_sla_expired" });
      const types = await c.outboxTypes();
      expect(types.filter((t) => t === "seller_order.accept_sla_expired")).toHaveLength(2);
      expect(types.filter((t) => t === "seller_order.cancelled")).toHaveLength(2);
      expect(types).toContain("order_group.cancelled");
      expect((await c.repo.getGroupForUser(GROUP_1, SHOPPER_A))?.status).toBe("CANCELLED");
      // idempotent: nothing left, nothing double-written
      expect(await k.commands.expireUnaccepted(10)).toEqual({ cancelled: 0, skipped: 0, failed: 0 });
    });

    it("rejection records the reason, emits one event for the refund saga and cancels no sibling", async () => {
      await placeTwoStoreGroup(k);
      const r = await k.commands.reject({
        sellerOrderId: ORDER_A,
        scope: sellerScope(STAFF_A, STORE_A),
        actorId: STAFF_A,
        idempotencyKey: "rej",
        reason: "out_of_stock",
      });
      expect(r.kind).toBe("ok");
      const o = await c.repo.getSellerOrder(ORDER_A, { kind: "system" });
      expect(o).toMatchObject({ status: "REJECTED_BY_SELLER", rejectReason: "out_of_stock" });
      expect((await c.outboxTypes()).filter((t) => t === "seller_order.rejected")).toHaveLength(1);
      expect((await c.repo.getSellerOrder(ORDER_B, { kind: "system" }))?.status).toBe("PAID");
      expect((await c.repo.getGroupForUser(GROUP_1, SHOPPER_A))?.status).toBe("PAID");
    });

    it("pack needs acceptance, ship needs packing, and shopper cancel stops at SHIPPED", async () => {
      await placeTwoStoreGroup(k);
      const s = sellerScope(STAFF_A, STORE_A);
      const base = { sellerOrderId: ORDER_A, scope: s, actorId: STAFF_A };
      expect((await k.commands.pack({ ...base, idempotencyKey: "p0" })).kind).toBe("invalid_transition");
      await k.commands.accept({ ...base, idempotencyKey: "a" });
      expect((await k.commands.pack({ ...base, idempotencyKey: "p1" })).kind).toBe("ok");
      expect((await k.commands.reject({ ...base, idempotencyKey: "r", reason: "other" })).kind).toBe("invalid_transition");
      const shipped = await k.commands.markShipped({ sellerOrderId: ORDER_A, commandKey: "shipment-1" });
      expect(shipped).toMatchObject({ kind: "ok" });
      const cancel = await k.commands.cancelByShopper({
        sellerOrderId: ORDER_A,
        userId: SHOPPER_A,
        idempotencyKey: "c",
        reason: "changed_mind",
      });
      expect(cancel.kind).toBe("not_cancellable");
      expect((await c.repo.getSellerOrder(ORDER_A, { kind: "system" }))?.status).toBe("SHIPPED");
    });

    it("shopper cancel works before shipping and only for the owner", async () => {
      await placeTwoStoreGroup(k);
      const other = await k.commands.cancelByShopper({
        sellerOrderId: ORDER_A,
        userId: SHOPPER_B,
        idempotencyKey: "x",
        reason: "other",
      });
      expect(other.kind).toBe("not_found");
      const mine = await k.commands.cancelByShopper({
        sellerOrderId: ORDER_A,
        userId: SHOPPER_A,
        idempotencyKey: "y",
        reason: "changed_mind",
      });
      expect(mine).toMatchObject({ kind: "ok" });
      if (mine.kind === "ok") expect(mine.order.buyer).toBeNull();
      expect((await c.outboxTypes()).filter((t) => t === "seller_order.cancelled")).toHaveLength(1);
    });

    it("a seller scope of another store cannot transition the order (RLS), nothing is written", async () => {
      await placeTwoStoreGroup(k);
      const before = (await c.outboxTypes()).length;
      const r = await k.commands.accept({
        sellerOrderId: ORDER_A,
        scope: sellerScope(STAFF_B, STORE_B),
        actorId: STAFF_B,
        idempotencyKey: "evil",
      });
      expect(r.kind).toBe("not_found");
      expect((await c.outboxTypes()).length).toBe(before);
      expect((await c.repo.getSellerOrder(ORDER_A, { kind: "system" }))?.status).toBe("PAID");
    });

    it("applyTransition with a stale version reports a conflict and writes nothing", async () => {
      await placeTwoStoreGroup(k);
      const s = sellerScope(STAFF_A, STORE_A);
      await k.commands.accept({ sellerOrderId: ORDER_A, scope: s, actorId: STAFF_A, idempotencyKey: "a1" });
      const types = (await c.outboxTypes()).length;
      const res = await c.repo.applyTransition({
        sellerOrderId: ORDER_A,
        scope: s,
        expectedVersion: 0,
        commandKey: "pack:stale",
        transition: {
          from: "ACCEPTED",
          to: "PACKED",
          event: "PACK",
          actorType: "SELLER",
          reasonCode: null,
          stamps: { packedAtMs: T0 },
        },
        actorId: STAFF_A,
        nowMs: T0,
        historyId: "00000000-0000-4000-8000-0000000fffff",
        events: [],
        rollup: () => null,
      });
      expect(res.kind).toBe("conflict");
      expect((await c.outboxTypes()).length).toBe(types);
      expect(await c.historyCount(ORDER_A)).toBe(1);
    });

    // ---- delivery, closure and the order_line.closed producer -----------------------------------

    async function shipOrderA(): Promise<void> {
      await placeTwoStoreGroup(k);
      const s = sellerScope(STAFF_A, STORE_A);
      await k.commands.accept({ sellerOrderId: ORDER_A, scope: s, actorId: STAFF_A, idempotencyKey: "a" });
      await k.commands.pack({ sellerOrderId: ORDER_A, scope: s, actorId: STAFF_A, idempotencyKey: "p" });
      await k.commands.markShipped({ sellerOrderId: ORDER_A, commandKey: "s" });
    }
    const DAY = 86_400_000;

    it("markDelivered passes through OUT_FOR_DELIVERY, stamps delivered_at and replays safely", async () => {
      await shipOrderA();
      const t = c.clock.nowMs() + 2 * DAY;
      const r = await k.commands.markDelivered({ sellerOrderId: ORDER_A, deliveredAtMs: t, commandKey: "evt-1" });
      expect(r).toMatchObject({ kind: "ok", replayed: false });
      if (r.kind !== "ok") return;
      expect(r.order.status).toBe("DELIVERED");
      expect(r.order.deliveredAtMs).toBe(t);
      const again = await k.commands.markDelivered({ sellerOrderId: ORDER_A, deliveredAtMs: t, commandKey: "evt-1" });
      expect(again).toMatchObject({ kind: "ok", replayed: true });
      const types = await c.outboxTypes();
      expect(types.filter((x) => x === "seller_order.delivered")).toHaveLength(1);
      expect(types.filter((x) => x === "seller_order.out_for_delivery")).toHaveLength(1);
      // a second, different delivery event for an order already DELIVERED is not a transition
      expect((await k.commands.markDelivered({ sellerOrderId: ORDER_A, deliveredAtMs: t, commandKey: "evt-2" })).kind).toBe("invalid_transition");
    });

    it("closeDelivered waits for the window, then closes once and emits one order_line.closed per line", async () => {
      await shipOrderA();
      await k.commands.markDelivered({ sellerOrderId: ORDER_A, deliveredAtMs: c.clock.nowMs(), commandKey: "evt" });
      expect(await k.commands.closeDelivered(10)).toEqual({ closed: 0, skipped: 0, failed: 0 });
      expect((await c.repo.getSellerOrder(ORDER_A, { kind: "system" }))?.status).toBe("DELIVERED");

      c.clock.advance(33 * DAY);
      expect(await k.commands.closeDelivered(10)).toEqual({ closed: 1, skipped: 0, failed: 0 });
      const o = await c.repo.getSellerOrder(ORDER_A, { kind: "system" });
      expect(o).toMatchObject({ status: "CLOSED", closedAtMs: c.clock.nowMs() });

      const events = await c.outboxEvents();
      const closed = events.filter((e) => e.type === "order_line.closed");
      expect(closed).toHaveLength(o?.lines.length ?? -1);
      expect(closed.length).toBe(2);
      for (const e of closed) {
        expect(e.payload).toMatchObject({
          seller_order_id: ORDER_A,
          order_group_id: GROUP_1,
          store_id: STORE_A,
          user_id: SHOPPER_A,
          currency: "EGP",
          refunded_merchandise_gross: "0",
          closed_at_ms: c.clock.nowMs(),
        });
        expect(e.payload["merchandise_gross"]).toMatch(/^\d+$/);
      }
      expect(new Set(closed.map((e) => e.payload["order_line_id"])).size).toBe(2);
      expect(events.filter((e) => e.type === "seller_order.closed")).toHaveLength(1);
      // idempotent: a second sweep and a replayed command write nothing
      const before = (await c.outboxTypes()).length;
      expect(await k.commands.closeDelivered(10)).toEqual({ closed: 0, skipped: 0, failed: 0 });
      expect((await c.outboxTypes()).length).toBe(before);
    });

    it("reports cumulative refunded goods per line at closure, capped at the line value", async () => {
      await shipOrderA();
      const order = await c.repo.getSellerOrder(ORDER_A, { kind: "system" });
      const first = order?.lines[0];
      if (first === undefined) throw new Error("no line");
      const gross = first.unitPrice.amount * BigInt(first.qty);
      const withRefunds = new OrderCommands({
        repo: c.repo,
        clock: c.clock,
        ids: createIdGenerator(c.clock, nodeCsprng),
        lineRefunds: { refundedGoodsByLine: async () => new Map([[first.id, gross + 5n]]) },
      });
      await withRefunds.markDelivered({ sellerOrderId: ORDER_A, deliveredAtMs: c.clock.nowMs(), commandKey: "evt" });
      c.clock.advance(34 * DAY);
      await withRefunds.closeDelivered(10);
      const closed = (await c.outboxEvents()).filter((e) => e.type === "order_line.closed");
      const mine = closed.find((e) => e.payload["order_line_id"] === first.id);
      expect(mine?.payload["refunded_merchandise_gross"]).toBe(gross.toString());
      expect(mine?.payload["merchandise_gross"]).toBe(gross.toString());
      const other = closed.find((e) => e.payload["order_line_id"] !== first.id);
      expect(other?.payload["refunded_merchandise_gross"]).toBe("0");
    });

    it("never closes a cancelled or not yet delivered order", async () => {
      await shipOrderA();
      c.clock.advance(60 * DAY);
      expect(await k.commands.closeDelivered(10)).toEqual({ closed: 0, skipped: 0, failed: 0 });
      expect((await c.outboxTypes()).filter((t) => t === "order_line.closed")).toHaveLength(0);
    });

    describe("order_line.closed return gate (A-9)", () => {
      const DAYMS = 86_400_000;
      const mk = (o: { days?: number | null; open?: ReadonlyMap<string, number> }) =>
        new OrderCommands({
          repo: c.repo,
          clock: c.clock,
          ids: createIdGenerator(c.clock, nodeCsprng),
          lineReturns: { openReturnsByLine: async () => o.open ?? new Map() },
          sellerWindows: { returnWindowDays: async () => o.days ?? null },
        });
      const closedEvents = async () => (await c.outboxEvents()).filter((e) => e.type === "order_line.closed");

      it("emits the window end from courier delivered_at (30 days + 3 margin) and zero open returns, matching the creators schema", async () => {
        await shipOrderA();
        const deliveredAt = c.clock.nowMs();
        const cmds = mk({});
        await cmds.markDelivered({ sellerOrderId: ORDER_A, deliveredAtMs: deliveredAt, commandKey: "evt" });
        c.clock.advance(33 * DAYMS);
        expect(await cmds.closeDelivered(10)).toEqual({ closed: 1, skipped: 0, failed: 0 });
        const ev = await closedEvents();
        expect(ev).toHaveLength(2);
        for (const e of ev) {
          expect(e.payload["return_window_ends_at_ms"]).toBe(deliveredAt + 33 * DAYMS);
          expect(e.payload["open_returns"]).toBe(0);
          expect(CreatorsLineClosed.parse(e.payload)).toMatchObject({
            return_window_ends_at_ms: deliveredAt + 33 * DAYMS,
            open_returns: 0,
          });
        }
      });

      it("a 45-day seller window closes only after 48 days and states that end", async () => {
        await shipOrderA();
        const deliveredAt = c.clock.nowMs();
        const cmds = mk({ days: 45 });
        await cmds.markDelivered({ sellerOrderId: ORDER_A, deliveredAtMs: deliveredAt, commandKey: "evt" });
        c.clock.advance(40 * DAYMS);
        expect(await cmds.closeDelivered(10)).toEqual({ closed: 0, skipped: 1, failed: 0 });
        expect(await closedEvents()).toHaveLength(0);
        c.clock.advance(8 * DAYMS);
        expect(await cmds.closeDelivered(10)).toEqual({ closed: 1, skipped: 0, failed: 0 });
        for (const e of await closedEvents()) expect(e.payload["return_window_ends_at_ms"]).toBe(deliveredAt + 48 * DAYMS);
      });

      it("a seller window below the statutory 30 days is clamped to 30", async () => {
        await shipOrderA();
        const deliveredAt = c.clock.nowMs();
        const cmds = mk({ days: 7 });
        await cmds.markDelivered({ sellerOrderId: ORDER_A, deliveredAtMs: deliveredAt, commandKey: "evt" });
        c.clock.advance(33 * DAYMS);
        await cmds.closeDelivered(10);
        for (const e of await closedEvents()) expect(e.payload["return_window_ends_at_ms"]).toBe(deliveredAt + 33 * DAYMS);
      });

      it("a line with a non-terminal return keeps the order unclosed and emits nothing; closes once it is terminal", async () => {
        await shipOrderA();
        const order = await c.repo.getSellerOrder(ORDER_A, { kind: "system" });
        const first = order?.lines[0]?.id;
        if (first === undefined) throw new Error("no line");
        const base = mk({});
        await base.markDelivered({ sellerOrderId: ORDER_A, deliveredAtMs: c.clock.nowMs(), commandKey: "evt" });
        c.clock.advance(60 * DAYMS);
        const before = (await c.outboxTypes()).length;
        const blocked = mk({ open: new Map([[first, 1]]) });
        expect(await blocked.closeDelivered(10)).toEqual({ closed: 0, skipped: 1, failed: 0 });
        expect((await c.repo.getSellerOrder(ORDER_A, { kind: "system" }))?.status).toBe("DELIVERED");
        expect((await c.outboxTypes()).length).toBe(before);
        expect(await mk({}).closeDelivered(10)).toEqual({ closed: 1, skipped: 0, failed: 0 });
        const mine = (await closedEvents()).find((e) => e.payload["order_line_id"] === first);
        expect(mine?.payload["open_returns"]).toBe(0);
      });

      it("replay writes nothing more", async () => {
        await shipOrderA();
        const cmds = mk({});
        await cmds.markDelivered({ sellerOrderId: ORDER_A, deliveredAtMs: c.clock.nowMs(), commandKey: "evt" });
        c.clock.advance(34 * DAYMS);
        await cmds.closeDelivered(10);
        const n = (await c.outboxTypes()).length;
        expect(await cmds.closeDelivered(10)).toEqual({ closed: 0, skipped: 0, failed: 0 });
        expect((await c.outboxTypes()).length).toBe(n);
      });

      it("without a returns port the facts are unknown (null) so creators defer", async () => {
        await shipOrderA();
        await k.commands.markDelivered({ sellerOrderId: ORDER_A, deliveredAtMs: c.clock.nowMs(), commandKey: "evt" });
        c.clock.advance(34 * DAYMS);
        await k.commands.closeDelivered(10);
        for (const e of await closedEvents()) expect(e.payload["open_returns"]).toBeNull();
      });
    });

    it("unknown and malformed ids are not found, never an error", async () => {
      expect(await c.repo.getSellerOrder("nope", { kind: "system" })).toBeNull();
      expect(await c.repo.locate("nope")).toBeNull();
      expect(await c.repo.locate(U9)).toBeNull();
      expect(await c.repo.hasCommand("nope", "k")).toBe(false);
    });
  });
}

/** Mirror of the creators consumer's `order_line.closed` schema (cross-module import is forbidden). */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CreatorsLineClosed = z.object({
  // shape-only: the fixtures use non-RFC ids; real ids are UUIDv7 (z.uuid() in the consumer)
  order_group_id: z.string().regex(UUID_SHAPE),
  order_line_id: z.string().regex(UUID_SHAPE),
  category_id: z.string().min(1).max(64).nullable().default(null),
  merchandise_gross: z.string().regex(/^[0-9]{1,18}$/),
  voucher_allocated: z.string().regex(/^[0-9]{1,18}$/),
  refunded_merchandise_gross: z.string().regex(/^[0-9]{1,18}$/),
  closed_at_ms: z.number().int().nonnegative(),
  return_window_ends_at_ms: z.number().int().nonnegative().nullable().default(null),
  open_returns: z.number().int().nonnegative().nullable().default(null),
});

const U9 = "00000000-0000-4000-8000-0000000009ff";
