/**
 * Shared contract suite for PaymentProviderPort (spec A2.10, B8, 7). A real PSP adapter (Paymob,
 * Kashier, Fawry) must pass this same suite, run against its recorded-fixture transport or sandbox:
 *
 *   paymentProviderContract("paymob (fixtures)", () => ({ port: new PaymobPort(cfg, new FixtureTransport()) }));
 */
import { describe, expect, it } from "vitest";
import type { PaymentProviderPort, CreateIntentRequest } from "../../../../apps/api/src/modules/payments/domain/ports";

export interface PaymentContractSubject {
  readonly port: PaymentProviderPort;
  /** Optional: simulate the shopper completing payment so refund/void paths can be exercised. */
  readonly markPaid?: (orderGroupId: string) => void;
  /** Optional: make the next call of `op` fail the given way (fakes and fixture transports). */
  readonly failNext?: (op: "create", failure: { kind: "timeout" } | { kind: "unavailable"; code: string }) => void;
  /** Optional: a correctly signed webhook (rawBody, headers) for any JSON body. */
  readonly signedWebhook?: (body: Record<string, unknown>) => { rawBody: Uint8Array; headers: Record<string, string> };
}

const KINDS = ["ok", "declined", "unavailable", "timeout", "invalid_response", "invalid_request"];
const uuid = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;

export function paymentProviderContract(name: string, make: () => PaymentContractSubject): void {
  const req = (n: number, over: Partial<CreateIntentRequest> = {}): CreateIntentRequest => ({
    orderGroupId: uuid(n),
    idempotencyKey: uuid(n),
    method: "card",
    amount: 125_000n,
    currency: "EGP",
    payer: { userId: uuid(9000 + n), phoneE164: "+201005550001", email: null },
    expiresInMs: 600_000,
    ...over,
  });

  describe(`PaymentProviderPort contract: ${name}`, () => {
    it("declares an id and a non-empty method set", () => {
      const { port } = make();
      expect(port.id.length).toBeGreaterThan(0);
      expect(port.methods.length).toBeGreaterThan(0);
    });

    it("createIntent returns a provider reference and a client action, and never card data", async () => {
      const { port } = make();
      const r = await port.createIntent(req(1));
      expect(KINDS).toContain(r.kind);
      expect(r.kind).toBe("ok");
      if (r.kind !== "ok") return;
      expect(r.value.providerRef.length).toBeGreaterThan(0);
      expect(r.value.clientAction).toHaveProperty("kind");
      expect(JSON.stringify(r.value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/\b\d{13,19}\b/);
    });

    it("createIntent is idempotent by orderGroupId (same intent, same reference)", async () => {
      const { port } = make();
      const a = await port.createIntent(req(2));
      const b = await port.createIntent(req(2));
      expect(a.kind).toBe("ok");
      expect(b).toEqual(a);
    });

    it("same orderGroupId with a different amount is refused, not silently re-priced", async () => {
      const { port } = make();
      await port.createIntent(req(3));
      const r = await port.createIntent(req(3, { amount: 1n }));
      expect(r.kind).not.toBe("ok");
    });

    it("a method the provider does not serve is invalid_request, never a throw", async () => {
      const { port } = make();
      const unsupported = (["card", "meeza", "apple_pay", "mobile_wallet", "instapay", "fawry"] as const).find((m) => !port.methods.includes(m));
      if (unsupported === undefined) return;
      const r = await port.createIntent(req(4, { method: unsupported }));
      expect(r.kind).toBe("invalid_request");
    });

    it("retrieve finds a created intent by order group and returns null for an unknown one", async () => {
      const { port } = make();
      await port.createIntent(req(5));
      const hit = await port.retrieve({ providerRef: null, orderGroupId: uuid(5) });
      expect(hit.kind).toBe("ok");
      if (hit.kind === "ok") {
        expect(hit.value).not.toBeNull();
        expect(hit.value?.amount).toBe(125_000n);
        expect(typeof hit.value?.amount).toBe("bigint");
      }
      const miss = await port.retrieve({ providerRef: null, orderGroupId: uuid(555) });
      expect(miss).toEqual({ kind: "ok", value: null });
    });

    it("operations on an unknown reference return a failure result and do not throw", async () => {
      const { port } = make();
      for (const r of [
        await port.capture({ providerRef: "nope", amount: 1n, idempotencyKey: uuid(6) }),
        await port.void({ providerRef: "nope", idempotencyKey: uuid(7) }),
        await port.refund({ providerRef: "nope", amount: 1n, idempotencyKey: uuid(8), reason: "x" }),
      ]) {
        expect(KINDS).toContain(r.kind);
        expect(r.kind).not.toBe("ok");
      }
    });

    it("void is idempotent on an unpaid intent", async () => {
      const { port } = make();
      const c = await port.createIntent(req(10));
      if (c.kind !== "ok") throw new Error("setup");
      const a = await port.void({ providerRef: c.value.providerRef, idempotencyKey: uuid(11) });
      const b = await port.void({ providerRef: c.value.providerRef, idempotencyKey: uuid(11) });
      expect(a).toEqual({ kind: "ok", value: { status: "voided" } });
      expect(b).toEqual(a);
    });

    it("refund is idempotent by key and amounts stay bigint piastres", async () => {
      const s = make();
      if (s.markPaid === undefined) return;
      const c = await s.port.createIntent(req(12));
      if (c.kind !== "ok") throw new Error("setup");
      s.markPaid(uuid(12));
      const a = await s.port.refund({ providerRef: c.value.providerRef, amount: 5_000n, idempotencyKey: uuid(13), reason: "return" });
      const b = await s.port.refund({ providerRef: c.value.providerRef, amount: 5_000n, idempotencyKey: uuid(13), reason: "return" });
      expect(a.kind).toBe("ok");
      expect(b).toEqual(a);
    });

    it("a timeout is reported as the AMBIGUOUS kind, not a decline", async () => {
      const s = make();
      if (s.failNext === undefined) return;
      s.failNext("create", { kind: "timeout" });
      const r = await s.port.createIntent(req(14));
      expect(r.kind).toBe("timeout");
    });

    it("verifyWebhook (event_id is the dedup key) rejects unsigned and tampered bodies and accepts a signed one", () => {
      const s = make();
      const now = Date.now();
      const body = new TextEncoder().encode(JSON.stringify({ event_id: "evt_1", hello: "world" }));
      expect(s.port.verifyWebhook({ rawBody: body, headers: {}, nowMs: now }).ok).toBe(false);
      if (s.signedWebhook === undefined) return;
      const signed = s.signedWebhook({ event_id: "evt_1", hello: "world" });
      expect(s.port.verifyWebhook({ ...signed, nowMs: now }).ok).toBe(true);
      const tampered = new TextEncoder().encode(JSON.stringify({ event_id: "evt_1", hello: "w0rld" }));
      expect(s.port.verifyWebhook({ rawBody: tampered, headers: signed.headers, nowMs: now }).ok).toBe(false);
    });
  });
}
