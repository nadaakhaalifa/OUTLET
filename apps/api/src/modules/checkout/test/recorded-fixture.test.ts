import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RecordedFixtureProvider, RecordedFixture } from "../adapters/recorded-fixture-provider";
import { money } from "../domain/bridge";

const SECRET = "fixture-secret";
const fixtures = [
  { operation: "create_intent", idempotency_key: "g1", response: { intent_id: "pi_1", action: "redirect", url: "https://pay.example.invalid/1" } },
  { operation: "create_intent", idempotency_key: "g2", response: { intent_id: "pi_2", action: "none", rejected_code: "declined" } },
  { operation: "void_intent", intent_id: "pi_1", result: "voided" },
  { operation: "refund", idempotency_key: "checkout:g1:refund" },
].map((f) => RecordedFixture.parse(f));

describe("RecordedFixtureProvider (replays recorded exchanges, no network)", () => {
  const p = new RecordedFixtureProvider("recorded-psp", fixtures, SECRET);

  it("replays recorded create, void and refund, and refuses anything unrecorded", async () => {
    const c = await p.createIntent({ idempotencyKey: "g1", amount: money(100n), method: "card", userId: "u" });
    expect(c).toMatchObject({ kind: "created", intentId: "pi_1", clientAction: { type: "redirect" } });
    expect(await p.createIntent({ idempotencyKey: "g2", amount: money(100n), method: "card", userId: "u" })).toEqual({ kind: "rejected", code: "declined" });
    expect(await p.voidIntent("pi_1")).toEqual({ kind: "voided" });
    await p.refund({ intentId: "pi_1", amount: money(100n), idempotencyKey: "checkout:g1:refund" });
    await expect(p.createIntent({ idempotencyKey: "nope", amount: money(1n), method: "card", userId: "u" })).rejects.toThrow(/no recorded/);
    await expect(p.refund({ intentId: "x", amount: money(1n), idempotencyKey: "nope" })).rejects.toThrow(/no recorded/);
  });

  it("verifies the HMAC over the raw body, the timestamp window and the strict body shape", () => {
    const now = 1_800_000_000_000;
    const raw = JSON.stringify({ id: "e1", intent_id: "pi_1", order_group_id: "g1", status: "succeeded", amount_piastres: "100", created_at_ms: now });
    const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
    expect(p.verifyWebhook(raw, { "x-signature": sig }, now)).toMatchObject({ ok: true, event: { eventId: "e1", kind: "succeeded" } });
    expect(p.verifyWebhook(raw, { "x-signature": "0".repeat(64) }, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(p.verifyWebhook(raw, {}, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(p.verifyWebhook(raw, { "x-signature": sig }, now + 6 * 60_000)).toEqual({ ok: false, reason: "stale_timestamp" });
    const extra = JSON.stringify({ ...JSON.parse(raw), surprise: 1 });
    const sig2 = createHmac("sha256", SECRET).update(extra).digest("hex");
    expect(p.verifyWebhook(extra, { "x-signature": sig2 }, now)).toEqual({ ok: false, reason: "malformed" });
  });
});
