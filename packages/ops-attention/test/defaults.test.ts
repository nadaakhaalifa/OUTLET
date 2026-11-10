import type { SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AttentionConsumer, PgAttentionReader, draftFor } from "../src/index.js";

const SH = "018f0000-0000-7000-8000-000000000005";
const E1 = "018f0000-0000-7000-8000-000000000e01";
const SRC = "018f0000-0000-7000-8000-000000000e02";
let admin: SqlClient;
let close: () => Promise<void>;

beforeAll(async () => { ({ client: admin, close } = await createTestClient()); });
afterAll(async () => close());
beforeEach(async () => {
  await admin.query("DELETE FROM attention_items");
  await admin.query("DELETE FROM outbox_events");
  await admin.query("DELETE FROM inbox_processed");
});

describe("draftFor shipment fallback", () => {
  it("references the source event when the payload names no shipment, and the delivery event id when it names neither", () => {
    expect(draftFor("shipment.cancel_attention", { shipment_id: null, reason: "r", source_event_id: SRC }, E1)).toMatchObject({ refType: "event", refId: SRC });
    expect(draftFor("shipment.cancel_attention", { shipment_id: null, reason: "r" }, E1)).toMatchObject({ refType: "event", refId: E1 });
    expect(draftFor("shipment.cancel_attention", { shipment_id: SH, reason: "r" }, E1)).toMatchObject({ refType: "shipment", refId: SH });
  });
});

describe("default clocks, loggers and ids", () => {
  it("a consumer with no options stamps the real clock and a generated id; the reader defaults its clock too", async () => {
    const before = Date.now();
    const c = new AttentionConsumer(roleClient(admin, "outlet_worker"), "EG");
    expect(await c.handle({ id: E1, type: "shipment.cancel_attention", payload: { shipment_id: SH, reason: "r" } })).toBe("processed");
    const row = (await admin.query<{ id: string; created_at: Date }>("SELECT id, created_at FROM attention_items")).rows[0];
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row?.created_at.getTime() ?? 0).toBeGreaterThanOrEqual(before - 1000);
    // parking an unknown type uses the default logger without throwing and still records the inbox row
    expect(await c.handle({ id: SRC, type: "nope", payload: {} })).toBe("processed");
    expect(await c.handle({ id: SRC, type: "nope", payload: {} })).toBe("duplicate");
    const page = await new PgAttentionReader(roleClient(admin, "outlet_app"), "EG").listOpen();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.refId).toBe(SH);
  });
});
