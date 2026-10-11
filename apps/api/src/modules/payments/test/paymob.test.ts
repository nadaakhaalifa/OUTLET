import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FixtureTransport, loadFixture } from "../adapters/paymob/fixture-transport";
import { hmacHex } from "../adapters/hmac-webhook";
import { PaymobPort, PAYMOB_SIGNATURE_HEADER, PAYMOB_TIMESTAMP_HEADER, type PaymobConfig } from "../adapters/paymob/port";
import type { CreateIntentRequest, JsonValue } from "../domain/ports";
import { FORBIDDEN_FIELD_NAMES } from "../domain/card-data-guard";
import { PAYMENT_METHOD_IDS, type PaymentMethodId } from "../domain/seam";
import { GROUP_1, SHOPPER_A, T0 } from "./fixtures";

const SECRET = "paymob-fixture-secret-not-real";
const cfg: PaymobConfig = {
  checkoutBaseUrl: "https://pay.fixture.invalid/unifiedcheckout/",
  publicKey: "pk_fixture_not_real",
  integrationIds: { card: 1001, meeza: 1002, apple_pay: 1003, mobile_wallet: 1004, instapay: 1005, fawry: 1006 },
  webhookSecrets: [SECRET],
};
const mk = (t = new FixtureTransport()) => ({ t, port: new PaymobPort(t, cfg) });
const req = (method: PaymentMethodId, over: Partial<CreateIntentRequest> = {}): CreateIntentRequest => ({
  orderGroupId: GROUP_1,
  idempotencyKey: GROUP_1,
  method,
  amount: 125_000n,
  currency: "EGP",
  payer: { userId: SHOPPER_A, phoneE164: "+201000000000", email: null },
  expiresInMs: 600_000,
  ...over,
});

const signed = (fixture: string, ts = T0, secret = SECRET) => {
  const rawBody = new TextEncoder().encode(JSON.stringify(loadFixture(fixture).body));
  const sig = hmacHex("sha512", secret, Buffer.concat([Buffer.from(`${ts}.`), Buffer.from(rawBody)]));
  return { rawBody, headers: { [PAYMOB_SIGNATURE_HEADER]: sig, [PAYMOB_TIMESTAMP_HEADER]: String(ts) } };
};

describe("PaymobPort against recorded-shape fixtures", () => {
  it("every fixture file declares hand-authored provenance and a VERIFY pointer", () => {
    const dir = new URL("../adapters/paymob/fixtures/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const j = JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { _provenance?: string };
      expect(j._provenance, f).toMatch(/HAND-AUTHORED/);
      expect(j._provenance, f).toMatch(/VERIFY BEFORE LAUNCH/);
    }
  });

  it("serves exactly the methods that have an integration id", () => {
    const only = new PaymobPort(new FixtureTransport(), { ...cfg, integrationIds: { card: 1 } });
    expect(only.methods).toEqual(["card"]);
    expect(new PaymobPort(new FixtureTransport(), cfg).methods).toEqual([...PAYMENT_METHOD_IDS]);
  });

  it.each([
    ["card", "iframe"],
    ["meeza", "iframe"],
    ["apple_pay", "apple_pay_session"],
    ["mobile_wallet", "redirect"],
    ["instapay", "qr_payload"],
    ["fawry", "reference_code"],
  ] as const)("creates a %s intent and maps the shopper action to %s", async (method, kind) => {
    const { port, t } = mk();
    const r = await port.createIntent(req(method));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.value.clientAction.kind).toBe(kind);
    expect(r.value.providerRef.length).toBeGreaterThan(3);
    const sent = t.requests[0];
    expect(sent?.idempotencyKey).toBe(GROUP_1);
    expect(sent?.body).toMatchObject({ amount: 125_000, currency: "EGP", special_reference: GROUP_1 });
    expect(Number.isInteger(sent?.body?.amount)).toBe(true);
  });

  it("Fawry: surfaces the reference and its 24h-style hard expiry from the PSP", async () => {
    const { port } = mk();
    const r = await port.createIntent(req("fawry"));
    if (r.kind !== "ok") throw new Error("unexpected");
    expect(r.value.clientAction).toMatchObject({ kind: "reference_code", reference: "FIXT123456" });
    expect(r.value.expiresAtMs).toBe(1_893_456_000_000);
  });

  it("the hosted checkout URL carries the public key and the client secret, nothing else sensitive", async () => {
    const { port } = mk();
    const r = await port.createIntent(req("card"));
    if (r.kind !== "ok" || r.value.clientAction.kind !== "iframe") throw new Error("unexpected");
    const u = new URL(r.value.clientAction.url);
    expect([...u.searchParams.keys()].sort()).toEqual(["clientSecret", "publicKey"]);
  });

  it("no request body or path declares a card-data field", async () => {
    const { port, t } = mk();
    for (const m of PAYMENT_METHOD_IDS) await port.createIntent(req(m));
    await port.refund({ providerRef: "i", amount: 1n, idempotencyKey: "k", reason: "r" });
    const keys = (v: unknown, acc: string[] = []): string[] => {
      if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          acc.push(k);
          keys(x, acc);
        }
      }
      return acc;
    };
    const all = t.requests.flatMap((r) => keys(r.body));
    expect(all.filter((k) => FORBIDDEN_FIELD_NAMES.test(k))).toEqual([]);
  });

  it("rejects unsupported methods and out-of-range amounts without calling the PSP", async () => {
    const { t } = mk();
    const lean = new PaymobPort(t, { ...cfg, integrationIds: { card: 1 } });
    expect(await lean.createIntent(req("fawry"))).toEqual({ kind: "invalid_request", code: "method_not_supported" });
    expect(await lean.createIntent(req("card", { amount: 0n }))).toEqual({ kind: "invalid_request", code: "amount_out_of_range" });
    expect(await lean.createIntent(req("card", { amount: 2n ** 60n }))).toEqual({ kind: "invalid_request", code: "amount_out_of_range" });
    expect(t.requests).toHaveLength(0);
  });

  it("maps transport and HTTP failures: timeout and 500 are ambiguous, 502/503/429/401 are safe to fail over, 4xx are ours", async () => {
    const run = async (...s: Parameters<FixtureTransport["script"]>) => mk(new FixtureTransport().script(...s)).port.createIntent(req("card"));
    expect(await run({ kind: "timeout" })).toEqual({ kind: "timeout" });
    expect(await run({ kind: "connect_error" })).toEqual({ kind: "unavailable", code: "connect_error" });
    expect(await run("server-error")).toEqual({ kind: "invalid_response" });
    expect(await run("bad-gateway")).toEqual({ kind: "unavailable", code: "http_502" });
    expect(await run("rate-limited")).toEqual({ kind: "unavailable", code: "rate_limited" });
    expect(await run("unauthorized")).toEqual({ kind: "unavailable", code: "psp_auth_rejected" });
    expect(await run("create-intention.bad-request")).toEqual({ kind: "invalid_request", code: "invalid_amount" });
    expect(await run("create-intention.malformed")).toEqual({ kind: "invalid_response" });
  });

  it("a duplicate special reference is resolved by retrieve, never by creating a second intention", async () => {
    const t = new FixtureTransport().script("create-intention.duplicate", "retrieve.succeeded");
    const port = new PaymobPort(t, cfg);
    const r = await port.createIntent(req("card"));
    expect(r.kind).toBe("ok");
    expect(t.requests.map((x) => x.op)).toEqual(["create_intention", "retrieve"]);
  });

  it("a duplicate whose amount differs is an idempotency mismatch", async () => {
    const t = new FixtureTransport().script("create-intention.duplicate", "retrieve.succeeded");
    const r = await new PaymobPort(t, cfg).createIntent(req("card", { amount: 5n }));
    expect(r).toEqual({ kind: "invalid_request", code: "idempotency_mismatch" });
  });

  it("capture, void, refund, retrieve and delete map their fixtures", async () => {
    const { port } = mk();
    expect(await port.capture({ providerRef: "i", amount: 1n, idempotencyKey: "k" })).toEqual({ kind: "ok", value: { status: "succeeded" } });
    expect(await port.void({ providerRef: "i", idempotencyKey: "k" })).toEqual({ kind: "ok", value: { status: "voided" } });
    expect(await port.refund({ providerRef: "i", amount: 1n, idempotencyKey: "k", reason: "r" })).toEqual({
      kind: "ok",
      value: { providerRefundRef: "rf_fixture_0001", status: "succeeded" },
    });
    const ret = await port.retrieve({ providerRef: "i", orderGroupId: GROUP_1 });
    expect(ret).toMatchObject({ kind: "ok", value: { status: "SUCCEEDED", amount: 125_000n, currency: "EGP" } });
    expect(await port.deleteToken({ pspToken: "tok_aaaaaaaa" })).toEqual({ kind: "ok", value: { status: "deleted" } });
  });

  it("refund outcomes: pending is pending, a rejected refund is a decline, retrieve 404 is null", async () => {
    const t = new FixtureTransport().script("refund.pending", "refund.declined", "retrieve.not-found");
    const port = new PaymobPort(t, cfg);
    const a = await port.refund({ providerRef: "i", amount: 1n, idempotencyKey: "k", reason: "r" });
    expect(a).toMatchObject({ kind: "ok", value: { status: "pending" } });
    const b = await port.refund({ providerRef: "i", amount: 1n, idempotencyKey: "k2", reason: "r" });
    expect(b).toEqual({ kind: "declined", code: "refund_exceeds_captured" });
    expect(await port.retrieve({ providerRef: "i", orderGroupId: GROUP_1 })).toEqual({ kind: "ok", value: null });
  });

  describe("webhooks", () => {
    const { port } = mk();
    const verify = (s: ReturnType<typeof signed>, nowMs = T0) => port.verifyWebhook({ rawBody: s.rawBody, headers: s.headers, nowMs });

    it("verifies a correctly signed fixture and derives a state-sensitive event id", () => {
      const v = verify(signed("webhook.succeeded"));
      expect(v).toMatchObject({ ok: true });
      const v2 = verify(signed("webhook.refunded"));
      if (!v.ok || !v2.ok) throw new Error("unexpected");
      expect(v.eventId).not.toBe(v2.eventId);
    });

    it("rejects a wrong secret, a missing header, and a stale or future timestamp", () => {
      expect(verify(signed("webhook.succeeded", T0, "other-secret"))).toEqual({ ok: false, reason: "bad_signature" });
      expect(port.verifyWebhook({ rawBody: new Uint8Array(2), headers: {}, nowMs: T0 })).toEqual({ ok: false, reason: "missing_signature" });
      expect(verify(signed("webhook.succeeded", T0 - 300_001))).toEqual({ ok: false, reason: "timestamp_out_of_window" });
      expect(verify(signed("webhook.succeeded", T0 + 300_001))).toEqual({ ok: false, reason: "timestamp_out_of_window" });
      expect(verify(signed("webhook.succeeded", T0 - 300_000))).toMatchObject({ ok: true });
    });

    it("F-14: a valid MAC over a 10-digit (epoch seconds) timestamp gets its own reason, not a clock error", () => {
      expect(verify(signed("webhook.succeeded", Math.floor(T0 / 1000)))).toEqual({ ok: false, reason: "timestamp_in_seconds" });
      expect(verify(signed("webhook.succeeded", Math.floor(T0 / 1000), "other-secret"))).toEqual({ ok: false, reason: "bad_signature" });
    });

    it("rotation: an older secret in the list still verifies", () => {
      const rotated = new PaymobPort(new FixtureTransport(), { ...cfg, webhookSecrets: ["new-secret", SECRET] });
      const s = signed("webhook.succeeded");
      expect(rotated.verifyWebhook({ rawBody: s.rawBody, headers: s.headers, nowMs: T0 })).toMatchObject({ ok: true });
    });

    it.each([
      ["webhook.succeeded", "payment.succeeded"],
      ["webhook.failed", "payment.failed"],
      ["webhook.voided", "payment.voided"],
      ["webhook.refunded", "refund.succeeded"],
    ])("normalizes %s to %s with piastre amounts", (fixture, kind) => {
      const p = port.parseWebhook(loadFixture(fixture).body as JsonValue);
      if (p.type !== "payment") throw new Error("unexpected");
      expect(p.event.kind).toBe(kind);
      expect(p.event.orderGroupId).toBe("00000000-0000-4000-8000-000000000001");
      expect(typeof p.event.amount).toBe("bigint");
    });

    it("pending callbacks are ignored, and a failure carries its code", () => {
      expect(port.parseWebhook(loadFixture("webhook.pending").body as JsonValue)).toEqual({ type: "ignored", reason: "pending" });
      const f = port.parseWebhook(loadFixture("webhook.failed").body as JsonValue);
      expect(f).toMatchObject({ type: "payment", event: { failureCode: "Insufficient funds" } });
    });

    it("a token callback becomes display data plus the PSP token only", () => {
      const p = port.parseWebhook(loadFixture("webhook.token").body as JsonValue);
      expect(p).toMatchObject({ type: "card_token", card: { last4: "2346", brand: "visa", psp_token: "tok_fixture_aaaaaaaaaaaaaaaa" } });
      if (p.type !== "card_token") throw new Error("unexpected");
      expect(Object.keys(p.card).sort()).toEqual(["brand", "exp_month", "exp_year", "fingerprint", "last4", "psp_token"]);
    });

    it("unknown shapes are invalid, never guessed", () => {
      expect(port.parseWebhook({ type: "SOMETHING", obj: {} })).toEqual({ type: "invalid", reason: "schema" });
    });
  });
});
