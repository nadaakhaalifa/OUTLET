import { applyDbContext, contextClient } from "@outlet/db";
import type { SqlClient } from "@outlet/db";
import { asRole, createTestClient, roleClient } from "@outlet/db/testing";
import { createLogger } from "@outlet/logger";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ATTENTION_OPENED_EVENT, AttentionConsumer, PgAttentionReader, draftFor } from "../src/index.js";

const G = "018f0000-0000-7000-8000-000000000002";
const S = "018f0000-0000-7000-8000-000000000003";
const R = "018f0000-0000-7000-8000-000000000004";
const SH = "018f0000-0000-7000-8000-000000000005";
const STAFF = "018f0000-0000-7000-8000-0000000000aa";
const E = (n: number): string => `018f0000-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`;

let admin: SqlClient;
let close: () => Promise<void>;
let logs: string[];
let tick = 0;
const consumer = (market = "EG"): AttentionConsumer =>
  new AttentionConsumer(roleClient(admin, "outlet_worker"), market, { now: () => new Date(Date.UTC(2026, 10, 9, 10, 0, tick++)), log: createLogger({ write: (l) => logs.push(l), level: "debug" }) });
const rows = async (): Promise<{ kind: string; ref_type: string; ref_id: string; payload: Record<string, string>; status: string }[]> =>
  (await admin.query<{ kind: string; ref_type: string; ref_id: string; payload: Record<string, string>; status: string }>("SELECT kind, ref_type, ref_id, payload, status FROM attention_items ORDER BY created_at, ref_id")).rows;
const opened = async (): Promise<number> => (await admin.query("SELECT 1 FROM outbox_events WHERE event_type = $1", [ATTENTION_OPENED_EVENT])).rows.length;

beforeAll(async () => { ({ client: admin, close } = await createTestClient()); });
afterAll(async () => close());
beforeEach(async () => {
  logs = [];
  await admin.query("DELETE FROM attention_items");
  await admin.query("DELETE FROM outbox_events");
  await admin.query("DELETE FROM inbox_processed");
});

describe("AttentionConsumer", () => {
  it("queues refund.attention from the cancellation consumer (group + seller order) and from the refund service (refund id)", async () => {
    const c = consumer();
    expect(await c.handle({ id: E(1), type: "refund.attention", payload: { order_group_id: G, seller_order_id: S, error: "REFUND_NOT_ALLOWED", source_event_id: E(9) } })).toBe("processed");
    expect(await c.handle({ id: E(2), type: "refund.attention", payload: { refund_id: R, status: "MANUAL_REVIEW", error: "psp timeout: card 4111111111111111" } })).toBe("processed");
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ kind: "refund.attention", ref_type: "order_group", ref_id: `${G}:${S}`, status: "OPEN" });
    expect(r[1]).toMatchObject({ ref_type: "refund", ref_id: R });
    expect(r[1]?.payload.error).toBe("psp_timeout:_card_#"); // free text is reduced to a code token
    expect(await opened()).toBe(2);
  });

  it("queues promotions.settle_attention per group and action", async () => {
    const c = consumer();
    await c.handle({ id: E(3), type: "promotions.settle_attention", payload: { order_group_id: G, action: "confirm", error: "invalid_payload", source_event_id: E(8) } });
    await c.handle({ id: E(4), type: "promotions.settle_attention", payload: { order_group_id: G, action: "release", error: "boom" } });
    expect((await rows()).map((x) => x.ref_id).sort()).toEqual([`${G}:confirm`, `${G}:release`]);
  });

  it("queues shipment.cancel_attention, falling back to the event id when the payload names no shipment", async () => {
    const c = consumer();
    await c.handle({ id: E(5), type: "shipment.cancel_attention", payload: { shipment_id: SH, seller_order_id: S, reason: "already_with_courier", source_event_id: E(7), market_id: "EG", occurred_at: "x" } });
    await c.handle({ id: E(6), type: "shipment.cancel_attention", payload: { shipment_id: null, seller_order_id: null, reason: "invalid_payload", source_event_id: E(7) } });
    const r = await rows();
    expect(r.map((x) => x.ref_type).sort()).toEqual(["event", "shipment"]);
    expect(r.find((x) => x.ref_type === "shipment")?.payload).toEqual({ shipment_id: SH, seller_order_id: S, reason: "already_with_courier", source_event_id: E(7) });
  });

  it("is idempotent: a replayed event id is a duplicate; a repeated failure for the same entity refreshes, never duplicates or reopens", async () => {
    const c = consumer();
    const ev = { id: E(10), type: "refund.attention", payload: { refund_id: R, status: "MANUAL_REVIEW", error: "first" } };
    expect(await c.handle(ev)).toBe("processed");
    expect(await c.handle(ev)).toBe("duplicate");
    expect(await c.handle({ id: E(11), type: "refund.attention", payload: { refund_id: R, status: "MANUAL_REVIEW", error: "second" } })).toBe("processed");
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]?.payload.error).toBe("second");
    expect(await opened()).toBe(1);
    await admin.query("UPDATE attention_items SET status = 'RESOLVED', resolved_at = now(), resolution_code = 'FIXED_MANUALLY'");
    await c.handle({ id: E(12), type: "refund.attention", payload: { refund_id: R, status: "MANUAL_REVIEW", error: "third" } });
    expect((await rows())[0]).toMatchObject({ status: "RESOLVED", payload: { error: "second" } });
  });

  it("parks a bad payload and an unknown type (inbox row + log, no item, no loop)", async () => {
    const c = consumer();
    expect(await c.handle({ id: E(20), type: "refund.attention", payload: { order_group_id: "nope", error: "x" } })).toBe("processed");
    expect(await c.handle({ id: E(21), type: "shipment.cancel_attention", payload: {} })).toBe("processed");
    expect(await c.handle({ id: E(22), type: "something.else", payload: {} })).toBe("processed");
    expect(await c.handle({ id: E(20), type: "refund.attention", payload: {} })).toBe("duplicate");
    expect(await rows()).toHaveLength(0);
    expect((await admin.query("SELECT 1 FROM inbox_processed WHERE consumer = 'ops.attention'")).rows).toHaveLength(3);
    expect(logs.filter((l) => l.includes("parked"))).toHaveLength(3);
    expect(await opened()).toBe(0);
  });

  it("draftFor rejects non-object junk per kind", () => {
    expect(draftFor("refund.attention", { error: 5 }, E(1))).toBeNull();
    expect(draftFor("promotions.settle_attention", { order_group_id: G }, E(1))).toBeNull();
    expect(draftFor("refund.attention", { order_group_id: null, error: "invalid_payload" }, E(1))).toMatchObject({ refType: "event", refId: E(1) });
    expect(draftFor("promotions.settle_attention", { order_group_id: null, action: "confirm", error: "e" }, E(2))).toMatchObject({ refType: "event", refId: E(2) });
    expect(draftFor("refund.attention", { order_group_id: G, error: "e" }, E(3))).toMatchObject({ refType: "order_group", refId: G });
  });
});

describe("grants and RLS on the real roles", () => {
  const item = async (market = "EG", ref = G): Promise<string> => {
    await consumer(market).handle({ id: `018f0000-0000-7000-8000-00000000f${String(tick++).padStart(3, "0")}`, type: "refund.attention", payload: { order_group_id: ref, error: "e" } });
    return (await admin.query<{ id: string }>("SELECT id FROM attention_items WHERE ref_id = $1", [ref])).rows[0]?.id ?? "";
  };
  const ins = "INSERT INTO attention_items (id, market_id, kind, ref_type, ref_id) VALUES ($1, 'EG', 'refund.attention', 'event', 'x')";

  it("worker with job ops.attention inserts; another job or the app role cannot", async () => {
    await item();
    await expect(asRole(admin, "outlet_worker", async (tx) => { await applyDbContext(tx, { kind: "worker", marketId: "EG", job: "checkout.settle" }); await tx.query(ins, [S]); })).rejects.toThrow();
    await expect(asRole(admin, "outlet_app", async (tx) => { await applyDbContext(tx, { kind: "user", marketId: "EG" }); await tx.query(ins, [S]); })).rejects.toThrow();
    await expect(asRole(admin, "outlet_worker", async (tx) => { await applyDbContext(tx, { kind: "worker", marketId: "XX", job: "ops.attention" }); await tx.query(ins, [S]); })).rejects.toThrow();
  });

  it("app reads only in a user context of its own market; store ctx and other markets see nothing; no DELETE", async () => {
    await item();
    const read = (ctx: Parameters<typeof applyDbContext>[1]): Promise<number> => asRole(admin, "outlet_app", async (tx) => { await applyDbContext(tx, ctx); return (await tx.query("SELECT 1 FROM attention_items")).rows.length; });
    expect(await read({ kind: "user", marketId: "EG" })).toBe(1);
    expect(await read({ kind: "user", marketId: "XX" })).toBe(0);
    expect(await read({ kind: "store", marketId: "EG", storeId: S })).toBe(0);
    await expect(asRole(admin, "outlet_app", async (tx) => { await applyDbContext(tx, { kind: "user", marketId: "EG" }); await tx.query("DELETE FROM attention_items"); })).rejects.toThrow();
    await expect(asRole(admin, "outlet_app", async (tx) => { await applyDbContext(tx, { kind: "user", marketId: "EG" }); await tx.query("UPDATE attention_items SET payload = '{}'::jsonb"); })).rejects.toThrow();
  });

  it("the unique key rejects a second row for the same (kind, ref_id) and status/resolution stay consistent", async () => {
    await item();
    await expect(admin.query("INSERT INTO attention_items (id, market_id, kind, ref_type, ref_id) VALUES ($1, 'EG', 'refund.attention', 'order_group', $2)", [S, G])).rejects.toThrow();
    await expect(admin.query("UPDATE attention_items SET status = 'RESOLVED'")).rejects.toThrow();
  });
});

describe("PgAttentionReader", () => {
  const reader = (market = "EG"): PgAttentionReader => new PgAttentionReader(roleClient(admin, "outlet_app"), market, () => new Date(Date.UTC(2026, 10, 9, 12, 0, 0)));
  const seed = async (n: number): Promise<string[]> => {
    const c = consumer();
    for (let i = 0; i < n; i++) await c.handle({ id: E(30 + i), type: "shipment.cancel_attention", payload: { shipment_id: `018f0000-0000-7000-8000-0000000002${String(i).padStart(2, "0")}`, reason: "r" } });
    return (await admin.query<{ id: string }>("SELECT id FROM attention_items ORDER BY created_at DESC, id DESC")).rows.map((r) => r.id);
  };

  it("lists open items newest first with a keyset cursor, and hides resolved and other-market items", async () => {
    const ids = await seed(5);
    await reader().resolve(ids[0] ?? "", STAFF, "NOT_AN_ISSUE");
    const p1 = await reader().listOpen({ limit: 2 }, STAFF);
    expect(p1.items.map((i) => i.id)).toEqual(ids.slice(1, 3));
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await reader().listOpen({ limit: 2, cursor: p1.nextCursor ?? "" });
    expect(p2.items.map((i) => i.id)).toEqual(ids.slice(3, 5));
    expect(p2.nextCursor).toBeNull();
    expect((await reader("XX").listOpen()).items).toHaveLength(0);
    expect((await reader().listOpen({ cursor: "!!garbage" })).items).toHaveLength(4);
    expect((await reader().listOpen({ cursor: Buffer.from("a|b|c").toString("base64url"), limit: 0 })).items).toHaveLength(1);
  });

  it("acks and resolves with the fixed codes; repeats are unchanged successes, conflicts and missing ids are reported", async () => {
    const [id] = await seed(1);
    const a = await reader().ack(id ?? "", STAFF);
    expect(a).toMatchObject({ outcome: "ok", changed: true, item: { status: "ACKED", ackedBy: STAFF } });
    expect(await reader().ack(id ?? "", STAFF)).toMatchObject({ outcome: "ok", changed: false });
    const r = await reader().resolve(id ?? "", STAFF, "RETRIED_OK");
    expect(r).toMatchObject({ outcome: "ok", changed: true, item: { status: "RESOLVED", resolutionCode: "RETRIED_OK" } });
    expect(await reader().resolve(id ?? "", STAFF, "RETRIED_OK")).toMatchObject({ outcome: "ok", changed: false });
    expect(await reader().resolve(id ?? "", STAFF, "DUPLICATE")).toMatchObject({ outcome: "conflict" });
    expect(await reader().ack(id ?? "", STAFF)).toMatchObject({ outcome: "conflict" });
    expect(await reader().ack(S, STAFF)).toEqual({ outcome: "not_found" });
    expect(await reader("XX").ack(id ?? "", STAFF)).toEqual({ outcome: "not_found" });
  });

  it("resolving an OPEN item records the actor as acker too; the DB refuses an unknown resolution code", async () => {
    const [id] = await seed(1);
    expect(await reader().resolve(id ?? "", STAFF, "ESCALATED")).toMatchObject({ item: { ackedBy: STAFF, status: "RESOLVED" } });
    const app = contextClient(roleClient(admin, "outlet_app"), { kind: "user", marketId: "EG" });
    await expect(app.query("UPDATE attention_items SET resolution_code = 'WHATEVER'")).rejects.toThrow();
  });

  it("countOpen counts non-resolved items by status and kind with the oldest age, one market only, and nothing for an empty queue", async () => {
    expect(await reader().countOpen()).toEqual({ open: 0, acked: 0, byKind: {}, oldestAt: null });
    const ids = await seed(3);
    const c = consumer();
    await c.handle({ id: E(60), type: "refund.attention", payload: { refund_id: R, status: "MANUAL_REVIEW", error: "e" } });
    await reader().ack(ids[0] ?? "", STAFF);
    await reader().resolve(ids[1] ?? "", STAFF, "NOT_AN_ISSUE");
    const n = await reader().countOpen(STAFF);
    expect(n).toMatchObject({ open: 2, acked: 1, byKind: { "shipment.cancel_attention": 2, "refund.attention": 1 } });
    expect(n.oldestAt).not.toBeNull();
    expect(await reader("XX").countOpen()).toEqual({ open: 0, acked: 0, byKind: {}, oldestAt: null });
  });

  it("runs the change hook inside the same transaction, only for a real change, and a throwing hook rolls the update back", async () => {
    const [id] = await seed(1);
    const seen: string[] = [];
    await reader().ack(id ?? "", STAFF, async (tx, item, before) => {
      seen.push(`${before}->${item.status}`);
      expect((await tx.query("SELECT 1 FROM attention_items WHERE id = $1 AND status = 'ACKED'", [item.id])).rows).toHaveLength(1);
    });
    await reader().ack(id ?? "", STAFF, () => { seen.push("again"); return Promise.resolve(); });
    await expect(reader().resolve(id ?? "", STAFF, "FIXED_MANUALLY", () => Promise.reject(new Error("audit down")))).rejects.toThrow("audit down");
    expect((await admin.query<{ status: string }>("SELECT status FROM attention_items WHERE id = $1", [id])).rows[0]?.status).toBe("ACKED");
    await reader().resolve(id ?? "", STAFF, "FIXED_MANUALLY", (_tx, item, before) => { seen.push(`${before}->${item.status}`); return Promise.resolve(); });
    expect(seen).toEqual(["OPEN->ACKED", "ACKED->RESOLVED"]);
  });
});
