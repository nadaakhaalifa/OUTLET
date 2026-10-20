import { describe, expect, it } from "vitest";
import { PaymentIntentNotFoundYet, ResolvePendingRefunds } from "../application/payments";
import { GROUP_1, GROUP_2, U } from "./fixtures";
import { cmd, createWorld, webhookBody } from "./world";

const deliver = async (w: ReturnType<typeof createWorld>, body: Record<string, unknown>, provider: "primary" | "secondary" = "primary", opts: { ts?: number } = {}) => {
  const p = provider === "primary" ? w.primary : w.secondary;
  const signed = p.signedWebhook(body, opts.ts ?? w.clock.nowMs());
  return w.receive.execute({ provider: p.id, rawBody: signed.rawBody, headers: signed.headers, ip: "203.0.113.5" });
};

describe("CreatePaymentIntent", () => {
  it("creates once per order group, idempotently, with the PSP called once", async () => {
    const w = createWorld();
    const a = await w.create.execute(cmd(GROUP_1));
    const b = await w.create.execute(cmd(GROUP_1));
    expect(a.kind).toBe("created");
    expect(b.kind).toBe("existing");
    if (a.kind !== "created" || b.kind !== "existing") throw new Error("unexpected");
    expect(b.intent.id).toBe(a.intent.id);
    expect(b.intent.clientAction).toEqual(a.intent.clientAction);
    expect(a.intent.status).toBe("REQUIRES_ACTION");
    expect(w.primary.callCount("create")).toBe(1);
    expect(a.intent.idempotencyKey).toBe(GROUP_1);
  });

  it("conflicts when the same order group is replayed with a different amount, method or user", async () => {
    const w = createWorld();
    await w.create.execute(cmd(GROUP_1));
    expect((await w.create.execute(cmd(GROUP_1, { amount: 1n }))).kind).toBe("conflict");
    expect((await w.create.execute(cmd(GROUP_1, { method: "instapay" }))).kind).toBe("conflict");
    expect((await w.create.execute(cmd(GROUP_1, { userId: U(2) }))).kind).toBe("conflict");
  });

  it("rejects non-positive amounts and non-EGP currency before any PSP call", async () => {
    const w = createWorld();
    expect(await w.create.execute(cmd(GROUP_1, { amount: 0n }))).toEqual({ kind: "invalid", code: "amount_not_positive" });
    expect(await w.create.execute({ ...cmd(GROUP_1), currency: "USD" })).toEqual({ kind: "invalid", code: "currency_not_supported" });
    expect(w.primary.calls).toHaveLength(0);
  });

  it("a killed method is not offered and cannot create intents; meeza follows the card switch", async () => {
    const w = createWorld();
    w.sw.disable("card");
    const list = await w.methods.execute({ containsDropSku: false });
    expect(list.find((m) => m.method === "card")).toMatchObject({ available: false, reason: "kill_switch" });
    expect(list.find((m) => m.method === "apple_pay")?.available).toBe(true);
    expect((await w.create.execute(cmd(GROUP_1))).kind).toBe("method_unavailable");
    expect((await w.create.execute(cmd(GROUP_2, { method: "meeza" }))).kind).toBe("method_unavailable");
    expect(w.primary.calls).toHaveLength(0);
  });

  it("Fawry: 24h reference expiry and non-drop pool metadata, and drop SKUs are refused", async () => {
    const w = createWorld();
    const list = await w.methods.execute({ containsDropSku: false });
    const fawry = list.find((m) => m.method === "fawry");
    expect(fawry).toMatchObject({ available: true, referenceExpiresInMs: 24 * 3_600_000, stockPool: "non_drop", paymentWindowMs: 24 * 3_600_000 });
    const withDrop = await w.methods.execute({ containsDropSku: true });
    expect(withDrop.find((m) => m.method === "fawry")).toMatchObject({ available: false, reason: "drop_sku_not_allowed" });
    expect((await w.create.execute(cmd(GROUP_1, { method: "fawry", containsDropSku: true }))).kind).toBe("method_unavailable");
    const ok = await w.create.execute(cmd(GROUP_2, { method: "fawry" }));
    if (ok.kind !== "created") throw new Error("unexpected");
    expect(ok.intent.clientAction?.kind).toBe("reference_code");
    expect(ok.intent.expiresAtMs).toBeLessThanOrEqual(w.clock.nowMs() + 24 * 3_600_000);
  });

  it("fails over to the secondary only on a definitive unavailable", async () => {
    const w = createWorld();
    w.primary.failNext("create", { kind: "unavailable", code: "http_503" }, 3);
    const r = await w.create.execute(cmd(GROUP_1));
    expect(r.kind).toBe("created");
    if (r.kind !== "created") throw new Error("unexpected");
    expect(r.intent.provider).toBe("fake_psp2");
    expect(w.secondary.callCount("create")).toBe(1);
  });

  it("never sends an ambiguous timeout to the secondary (double charge risk) and keeps the intent pending", async () => {
    const w = createWorld();
    w.primary.failNext("create", { kind: "timeout" }, 3);
    const r = await w.create.execute(cmd(GROUP_1));
    expect(r.kind).toBe("pending_unknown");
    expect(w.secondary.calls).toHaveLength(0);
    expect(w.primary.callCount("create")).toBe(3);
    expect(w.sleeps).toHaveLength(2);
    if (r.kind !== "pending_unknown") throw new Error("unexpected");
    expect(r.intent.status).toBe("CREATED");
    expect(r.intent.provider).toBe("fake_psp");
  });

  it("a timeout followed by a retry with the same order group resumes the same PSP intent", async () => {
    const w = createWorld();
    w.primary.failNext("create", { kind: "timeout" }, 3);
    const first = await w.create.execute(cmd(GROUP_1));
    expect(first.kind).toBe("pending_unknown");
    const second = await w.create.execute(cmd(GROUP_1));
    expect(second.kind).toBe("existing");
    if (second.kind !== "existing") throw new Error("unexpected");
    expect(second.intent.status).toBe("REQUIRES_ACTION");
    expect(w.primary.callCount("create")).toBe(4);
  });

  it("a decline fails the intent with a payment.failed event and does not trip the breaker", async () => {
    const w = createWorld();
    w.primary.failNext("create", { kind: "declined", code: "card_blocked" });
    const r = await w.create.execute(cmd(GROUP_1));
    expect(r.kind).toBe("declined");
    expect(w.store.outboxTypes()).toEqual(["payment.failed"]);
    expect(w.router.breakerState("fake_psp")).toEqual({ kind: "closed", failures: 0 });
  });

  it("opens the circuit after repeated unavailability and routes straight to the secondary", async () => {
    const w = createWorld();
    w.primary.failNext("create", { kind: "unavailable", code: "http_503" }, 20);
    for (let i = 0; i < 5; i++) await w.create.execute(cmd(U(500 + i)));
    expect(w.router.breakerState("fake_psp").kind).toBe("open");
    const before = w.primary.callCount("create");
    const r = await w.create.execute(cmd(U(600)));
    expect(r.kind).toBe("created");
    expect(w.primary.callCount("create")).toBe(before);
  });

  it("hides a method when no provider is admitting calls", async () => {
    const w = createWorld({ providers: [] });
    const list = await w.methods.execute({ containsDropSku: false });
    expect(list.every((m) => !m.available && m.reason === "no_provider")).toBe(true);
  });
});

describe("webhook intake", () => {
  it("stores verified events, answers accepted, and processes exactly once on replay", async () => {
    const w = createWorld();
    const c = await w.create.execute(cmd(GROUP_1));
    if (c.kind !== "created") throw new Error("unexpected");
    const body = webhookBody("payment.succeeded", { provider_ref: c.intent.providerRef, order_group_id: GROUP_1 });
    expect(await deliver(w, body)).toEqual({ kind: "accepted", signatureOk: true, duplicate: false });
    expect(await deliver(w, body)).toEqual({ kind: "accepted", signatureOk: true, duplicate: true });
    const drained = await w.process.drain(10);
    expect(drained).toBe(1);
    expect(await w.process.drain(10)).toBe(0);
    expect((await w.store.getIntent(c.intent.id))?.status).toBe("SUCCEEDED");
    expect(w.store.outboxTypes().filter((t) => t === "payment.succeeded")).toHaveLength(1);
  });

  it("a stale timestamp is stored as unverified and changes nothing", async () => {
    const w = createWorld();
    const c = await w.create.execute(cmd(GROUP_1));
    if (c.kind !== "created") throw new Error("unexpected");
    const body = webhookBody("payment.succeeded", { provider_ref: c.intent.providerRef, order_group_id: GROUP_1 });
    const r = await deliver(w, body, "primary", { ts: w.clock.nowMs() - 6 * 60_000 });
    expect(r).toEqual({ kind: "accepted", signatureOk: false, duplicate: false });
    expect(w.store.allRawEvents()[0]).toMatchObject({ signatureOk: false, rejectReason: "timestamp_out_of_window" });
    expect(await w.process.drain(10)).toBe(0);
    expect((await w.store.getIntent(c.intent.id))?.status).toBe("REQUIRES_ACTION");
  });

  it("accepts the edge of the +-5 minute window and rejects 1 ms beyond it, in both directions", async () => {
    const w = createWorld();
    const mk = (n: number) => webhookBody("payment.authorized", { event_id: `e${n}` });
    expect((await deliver(w, mk(1), "primary", { ts: w.clock.nowMs() - 300_000 })).kind).toBe("accepted");
    expect(w.store.allRawEvents().at(-1)?.signatureOk).toBe(true);
    await deliver(w, mk(2), "primary", { ts: w.clock.nowMs() - 300_001 });
    expect(w.store.allRawEvents().at(-1)?.signatureOk).toBe(false);
    await deliver(w, mk(3), "primary", { ts: w.clock.nowMs() + 300_001 });
    expect(w.store.allRawEvents().at(-1)?.signatureOk).toBe(false);
  });

  it("a body signed with another provider's secret is not authentic", async () => {
    const w = createWorld();
    const signed = w.secondary.signedWebhook(webhookBody("payment.succeeded"));
    const r = await w.receive.execute({ provider: "fake_psp", rawBody: signed.rawBody, headers: signed.headers, ip: "203.0.113.5" });
    expect(r).toMatchObject({ kind: "accepted", signatureOk: false });
  });

  it("a tampered body fails the MAC even with a valid header", async () => {
    const w = createWorld();
    const signed = w.primary.signedWebhook(webhookBody("payment.succeeded", { amount: "1" }));
    const tampered = new TextEncoder().encode(new TextDecoder().decode(signed.rawBody).replace('"1"', '"2"'));
    const r = await w.receive.execute({ provider: "fake_psp", rawBody: tampered, headers: signed.headers, ip: "203.0.113.5" });
    expect(r).toMatchObject({ kind: "accepted", signatureOk: false });
    expect(w.store.allRawEvents()[0]?.rejectReason).toBe("bad_signature");
  });

  it("denies sources outside the IP allow-list and stores nothing", async () => {
    const w = createWorld({ ipAllowList: { isAllowed: async () => false } });
    const signed = w.primary.signedWebhook(webhookBody("payment.succeeded"));
    const r = await w.receive.execute({ provider: "fake_psp", rawBody: signed.rawBody, headers: signed.headers, ip: "198.51.100.9" });
    expect(r).toEqual({ kind: "ip_denied" });
    expect(w.store.allRawEvents()).toHaveLength(0);
  });

  it("unknown provider and oversized bodies are refused before storage", async () => {
    const w = createWorld();
    expect(await w.receive.execute({ provider: "nope", rawBody: new Uint8Array(1), headers: {}, ip: "1.1.1.1" })).toEqual({ kind: "unknown_provider" });
    expect(await w.receive.execute({ provider: "fake_psp", rawBody: new Uint8Array(300 * 1024), headers: {}, ip: "1.1.1.1" })).toEqual({ kind: "too_large" });
    expect(w.store.allRawEvents()).toHaveLength(0);
  });

  it("redacts a PAN-shaped value before storage and raises pan_in_webhook", async () => {
    const w = createWorld();
    const body = webhookBody("payment.authorized", { event_id: "pan1", note: "4242 4242 4242 4242" });
    await deliver(w, body);
    const stored = JSON.stringify(w.store.allRawEvents()[0]?.body);
    expect(stored).not.toContain("4242 4242 4242 4242");
    expect(stored).toContain("[REDACTED]");
    expect(w.store.outbox.some((o) => o.type === "payment.anomaly" && o.payload.anomaly === "pan_in_webhook")).toBe(true);
  });

  it("an event for an intent not written yet is retried, then becomes an anomaly after the grace period", async () => {
    const w = createWorld();
    await deliver(w, webhookBody("payment.succeeded", { order_group_id: GROUP_2, provider_ref: "ghost" }));
    const id = w.store.allRawEvents()[0]?.id ?? "";
    await expect(w.process.handle(id)).rejects.toBeInstanceOf(PaymentIntentNotFoundYet);
    w.clock.advance(11 * 60_000);
    expect(await w.process.handle(id)).toBe("anomaly");
    expect(w.store.outbox.some((o) => o.payload.anomaly === "unknown_intent")).toBe(true);
  });

  it("an amount mismatch is an anomaly and never moves the intent to SUCCEEDED", async () => {
    const w = createWorld();
    const c = await w.create.execute(cmd(GROUP_1));
    if (c.kind !== "created") throw new Error("unexpected");
    await deliver(w, webhookBody("payment.succeeded", { provider_ref: c.intent.providerRef, order_group_id: GROUP_1, amount: "100" }));
    await w.process.drain(10);
    expect((await w.store.getIntent(c.intent.id))?.status).toBe("REQUIRES_ACTION");
    expect(w.store.outbox.some((o) => o.payload.anomaly === "amount_mismatch")).toBe(true);
  });

  it("success after expiry/failure is a late_success anomaly for checkout to resolve", async () => {
    const w = createWorld();
    const c = await w.create.execute(cmd(GROUP_1));
    if (c.kind !== "created") throw new Error("unexpected");
    await deliver(w, webhookBody("payment.failed", { provider_ref: c.intent.providerRef, order_group_id: GROUP_1, failure_code: "declined" }));
    await deliver(w, webhookBody("payment.succeeded", { provider_ref: c.intent.providerRef, order_group_id: GROUP_1 }));
    await w.process.drain(10);
    expect((await w.store.getIntent(c.intent.id))?.status).toBe("FAILED");
    expect(w.store.outbox.some((o) => o.payload.anomaly === "late_success")).toBe(true);
  });

  it("stores a tokenized card from a webhook, never a PAN", async () => {
    const w = createWorld();
    await deliver(w, {
      type: "card.tokenized",
      event_id: "tok1",
      user_id: U(1),
      card: { psp_token: "tok_live_like_aaaaaaaa", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2031, fingerprint: "fp_aaaaaaaaaaaa" },
    });
    await w.process.drain(5);
    const cards = await w.cards.execute(U(1));
    expect(cards).toHaveLength(1);
    expect(Object.keys(cards[0] ?? {}).sort()).toEqual(
      ["brand", "createdAtMs", "expMonth", "expYear", "fingerprint", "id", "last4", "provider", "pspToken", "userId"],
    );
  });
});

describe("capture, void, refund", () => {
  const paid = async (w: ReturnType<typeof createWorld>, amount = 100_000n) => {
    const c = await w.create.execute(cmd(GROUP_1, { amount }));
    if (c.kind !== "created") throw new Error("unexpected");
    w.primary.setRemoteStatus(GROUP_1, "SUCCEEDED");
    await deliver(w, webhookBody("payment.succeeded", { provider_ref: c.intent.providerRef, order_group_id: GROUP_1, amount: amount.toString() }));
    await w.process.drain(5);
    return c.intent;
  };

  it("authorize then capture: SUCCEEDED once, a second capture is a no-op", async () => {
    const w = createWorld();
    const c = await w.create.execute(cmd(GROUP_1));
    if (c.kind !== "created") throw new Error("unexpected");
    await deliver(w, webhookBody("payment.authorized", { provider_ref: c.intent.providerRef, order_group_id: GROUP_1 }));
    await w.process.drain(5);
    w.primary.setRemoteStatus(GROUP_1, "AUTHORIZED");
    const cap = await w.capture.execute(c.intent.id);
    expect(cap.kind).toBe("ok");
    expect((await w.store.getIntent(c.intent.id))?.status).toBe("SUCCEEDED");
    expect((await w.capture.execute(c.intent.id)).kind).toBe("ok");
    expect(w.store.outboxTypes().filter((t) => t === "payment.succeeded")).toHaveLength(1);
  });

  it("void is refused after capture and idempotent before it", async () => {
    const w = createWorld();
    const c = await w.create.execute(cmd(GROUP_1));
    if (c.kind !== "created") throw new Error("unexpected");
    expect((await w.voidPayment.execute(c.intent.id)).kind).toBe("ok");
    expect((await w.voidPayment.execute(c.intent.id)).kind).toBe("ok");
    expect(w.store.outboxTypes().filter((t) => t === "payment.voided")).toHaveLength(1);
    const w2 = createWorld();
    const i = await paid(w2);
    expect(await w2.voidPayment.execute(i.id)).toEqual({ kind: "invalid_state", status: "SUCCEEDED" });
  });

  it("partial then full refund; the same idempotency key never refunds twice at the PSP", async () => {
    const w = createWorld();
    const i = await paid(w, 100_000n);
    const a = await w.refund.execute({ intentId: i.id, amount: 40_000n, idempotencyKey: "rf-a", reason: "return" });
    const again = await w.refund.execute({ intentId: i.id, amount: 40_000n, idempotencyKey: "rf-a", reason: "return" });
    expect(a.kind).toBe("completed");
    expect(again.kind).toBe("completed");
    expect(w.primary.callCount("refund")).toBe(1);
    expect((await w.store.getIntent(i.id))?.status).toBe("PARTIALLY_REFUNDED");
    expect((await w.refund.execute({ intentId: i.id, amount: 70_000n, idempotencyKey: "rf-b", reason: "x" })).kind).toBe("exceeds_captured");
    expect((await w.refund.execute({ intentId: i.id, amount: 60_000n, idempotencyKey: "rf-c", reason: "x" })).kind).toBe("completed");
    const fin = await w.store.getIntent(i.id);
    expect(fin?.status).toBe("REFUNDED");
    expect(fin?.refundedAmount).toBe(100_000n);
  });

  it("a refund timeout leaves it pending and a retry with the same key reuses the same record", async () => {
    const w = createWorld();
    const i = await paid(w);
    w.primary.failNext("refund", { kind: "timeout" }, 3);
    const a = await w.refund.execute({ intentId: i.id, amount: 10_000n, idempotencyKey: "rf-t", reason: "x" });
    expect(a.kind).toBe("pending");
    const b = await w.refund.execute({ intentId: i.id, amount: 10_000n, idempotencyKey: "rf-t", reason: "x" });
    expect(b.kind).toBe("completed");
    if (a.kind !== "pending" || b.kind !== "completed") throw new Error("unexpected");
    expect(b.refund.id).toBe(a.refund.id);
  });

  it("a pending refund is settled by its webhook, matched by amount when the reference is unknown", async () => {
    const w = createWorld();
    const i = await paid(w);
    w.primary.failNext("refund", { kind: "timeout" }, 3);
    await w.refund.execute({ intentId: i.id, amount: 15_000n, idempotencyKey: "rf-w", reason: "x" });
    await deliver(w, webhookBody("refund.succeeded", { provider_ref: i.providerRef, order_group_id: GROUP_1, amount: "15000", refund_ref: "rf_remote_1" }));
    await w.process.drain(5);
    expect((await w.store.getIntent(i.id))?.refundedAmount).toBe(15_000n);
  });

  it("F-9: two equal pending refunds with out-of-order webhooks are never settled by amount; replay by key resolves each", async () => {
    const w = createWorld();
    const i = await paid(w);
    w.primary.failNext("refund", { kind: "timeout" }, 3);
    const a = await w.refund.execute({ intentId: i.id, amount: 15_000n, idempotencyKey: "rf-eq-1", reason: "x" });
    w.primary.failNext("refund", { kind: "timeout" }, 3);
    const b = await w.refund.execute({ intentId: i.id, amount: 15_000n, idempotencyKey: "rf-eq-2", reason: "x" });
    expect([a.kind, b.kind]).toEqual(["pending", "pending"]);
    // the webhook for the SECOND refund (a failure) arrives first, then the first one's success
    await deliver(w, webhookBody("refund.failed", { event_id: "evt_f2", provider_ref: i.providerRef, order_group_id: GROUP_1, amount: "15000", refund_ref: "rf_remote_2", failure_code: "x" }));
    await deliver(w, webhookBody("refund.succeeded", { event_id: "evt_s1", provider_ref: i.providerRef, order_group_id: GROUP_1, amount: "15000", refund_ref: "rf_remote_1" }));
    await w.process.drain(5);
    expect((await w.store.getIntent(i.id))?.refundedAmount).toBe(0n);
    if (a.kind !== "pending" || b.kind !== "pending") throw new Error("unexpected");
    expect((await w.store.getRefundByKey(i.id, "rf-eq-1"))?.status).toBe("pending");
    expect((await w.store.getRefundByKey(i.id, "rf-eq-2"))?.status).toBe("pending");
    expect(await w.store.findPendingRefunds(i.id, 15_000n)).toHaveLength(2);
    const resolved = await new ResolvePendingRefunds(w.store, w.router).execute();
    expect(resolved).toBe(2);
    expect((await w.store.getRefundByKey(i.id, "rf-eq-1"))?.status).toBe("succeeded");
    expect((await w.store.getRefundByKey(i.id, "rf-eq-2"))?.status).toBe("succeeded");
    expect((await w.store.getIntent(i.id))?.refundedAmount).toBe(30_000n);
  });

  it("refund on an unknown intent is not_found, non-positive is invalid", async () => {
    const w = createWorld();
    expect(await w.refund.execute({ intentId: U(9999), amount: 1n, idempotencyKey: "k", reason: "x" })).toEqual({ kind: "not_found" });
    expect(await w.refund.execute({ intentId: U(9999), amount: 0n, idempotencyKey: "k", reason: "x" })).toEqual({ kind: "invalid_amount" });
  });
});

describe("ExpirePaymentIntents", () => {
  it("fails and voids an overdue unpaid intent", async () => {
    const w = createWorld();
    const c = await w.create.execute(cmd(GROUP_1));
    if (c.kind !== "created") throw new Error("unexpected");
    w.clock.advance(11 * 60_000);
    expect(await w.expire.execute()).toBe(1);
    const cur = await w.store.getIntent(c.intent.id);
    expect(cur).toMatchObject({ status: "FAILED", failureCode: "expired" });
    expect(w.primary.remoteIntent(GROUP_1)?.status).toBe("VOIDED");
  });

  it("a late success wins: the sweeper retrieves before voiding", async () => {
    const w = createWorld();
    const c = await w.create.execute(cmd(GROUP_1));
    if (c.kind !== "created") throw new Error("unexpected");
    w.primary.setRemoteStatus(GROUP_1, "SUCCEEDED");
    w.clock.advance(11 * 60_000);
    await w.expire.execute();
    expect((await w.store.getIntent(c.intent.id))?.status).toBe("SUCCEEDED");
    expect(w.primary.callCount("void")).toBe(0);
  });

  it("leaves the intent alone when the PSP cannot be asked", async () => {
    const w = createWorld();
    const c = await w.create.execute(cmd(GROUP_1));
    if (c.kind !== "created") throw new Error("unexpected");
    w.primary.failNext("retrieve", { kind: "timeout" }, 3);
    w.clock.advance(11 * 60_000);
    expect(await w.expire.execute()).toBe(0);
    expect((await w.store.getIntent(c.intent.id))?.status).toBe("REQUIRES_ACTION");
  });
});
