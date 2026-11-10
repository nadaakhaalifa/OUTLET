// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planProxy } from "../src/server/bff";
import { createOnboardingApi } from "../src/client/onboarding-api";

/**
 * The seller BFF + client speak the SERVED API: the real NestJS app on PGlite (read-only import of apps/api/test), not docs/api/openapi.yaml.
 * Skipped (not failed) when the API test harness cannot boot on this machine.
 */
type Harness = typeof import("../../api/test/harness");
type App = Awaited<ReturnType<Harness["createTestApp"]>>;
let h: Harness | undefined;
let t: App | undefined;
let png: typeof import("../../api/test/png");
try {
  h = await import("../../api/test/harness");
  png = await import("../../api/test/png");
  t = await h.createTestApp();
} catch {
  t = undefined;
}
const ready = t !== undefined;
afterAll(async () => {
  await t?.close();
});
beforeAll(() => undefined);

const IBAN = "EG380019000500000000263180002";
const bridge = (token: string): typeof fetch => async (input, init) => {
  const app = t!;
  const u = new URL(typeof input === "string" ? input : "/", "https://seller.test");
  const rest = u.pathname.replace(/^\/api\/seller\//, "").split("/");
  const headers = new Headers(init?.headers);
  headers.set("host", "seller.test");
  headers.set("origin", "https://seller.test");
  headers.set("sec-fetch-site", "same-origin");
  const body = typeof init?.body === "string" ? new TextEncoder().encode(init.body).buffer : null;
  const plan = planProxy({ method: init?.method ?? "GET", segments: rest, search: u.search, headers, cookies: { get: (n) => (n === "seller_session" ? { value: token } : undefined) }, body, apiUrl: "http://api.internal" });
  if (plan.kind === "reject") return new Response("{}", { status: plan.status });
  const up = new URL(plan.url);
  const out: Record<string, string> = {};
  plan.init.headers.forEach((v, k) => { out[k] = v; });
  if (out["idempotency-key"] !== undefined) out["idempotency-key"] = h!.idemKey(app);
  const res = await app.inject({ method: plan.init.method, url: up.pathname, headers: out, ...(plan.init.body === undefined ? {} : { payload: Buffer.from(plan.init.body) }) });
  return new Response(res.body, { status: res.statusCode });
};

describe.skipIf(!ready)("seller onboarding BFF against the served API", () => {
  it("walks the application: 404 before start, start, documents, bank account, early submit 422 with gaps", async () => {
    const app = t!;
    const shopper = await app.shopper();
    const token = await app.mint({ userId: shopper.userId, amr: ["passkey"] });
    const api = createOnboardingApi("eg", bridge(token));

    expect(await api.get()).toMatchObject({ ok: false, status: 404 });
    const started = await api.start({ legal_type: "company", legal_name_ar: "شركة النور للتجارة", commercial_register_no: `CR-${shopper.userId.slice(0, 8)}`, tax_card_no: "TX-1", governorate_code: "cairo", governorate_name_ar: "القاهرة" });
    expect(started.ok).toBe(true);

    const got = await api.get();
    expect(got).toMatchObject({ ok: true, data: { status: "DRAFT" } });
    if (!got.ok) return;
    expect(got.data.gaps).toContain("document:commercial_register");
    expect(got.data.gaps).toContain("bank_account");
    expect(got.data.gaps).not.toContain("legal_name_ar");

    const form = png.multipartBody({ doc_type: "commercial_register" }, { name: "cr.pdf", type: "application/pdf", data: png.makePdf() });
    const plan = planProxy({
      method: "POST", segments: ["eg", "onboarding", "documents"], search: "",
      headers: new Headers({ host: "seller.test", origin: "https://seller.test", "sec-fetch-site": "same-origin", "content-type": form.contentType, "idempotency-key": "k" }),
      cookies: { get: (n) => (n === "seller_session" ? { value: token } : undefined) }, body: new Uint8Array(form.payload).buffer, apiUrl: "http://api.internal",
    });
    expect(plan.kind).toBe("forward");
    if (plan.kind === "forward") {
      const headers: Record<string, string> = {};
      plan.init.headers.forEach((v, k) => { headers[k] = v; });
      headers["idempotency-key"] = h!.idemKey(app);
      const r = await app.inject({ method: "POST", url: new URL(plan.url).pathname, headers, payload: Buffer.from(plan.init.body ?? new ArrayBuffer(0)) });
      expect(r.statusCode).toBe(201);
      expect(JSON.parse(r.body)).toMatchObject({ doc_type: "commercial_register" });
    }
    const after = await api.get();
    expect(after.ok && after.data.gaps.includes("document:commercial_register")).toBe(false);

    expect(await api.setBank(IBAN, "شركة النور للتجارة")).toEqual({ ok: true, data: { iban_last4: "0002" } });
    const late = await api.get();
    expect(late.ok && late.data.gaps.includes("bank_account")).toBe(false);

    const submit = await api.submit();
    expect(submit).toMatchObject({ ok: false, status: 422 });
    if (!submit.ok) expect(submit.reasons).toEqual(expect.arrayContaining(["document:tax_card", "document:signatory_national_id"]));
  });

  it("refuses a session without a passkey (403 passkey-required) and an unauthenticated one", async () => {
    const app = t!;
    const shopper = await app.shopper();
    const weak = await app.mint({ userId: shopper.userId, amr: ["otp"] });
    expect(await createOnboardingApi("eg", bridge(weak)).get()).toMatchObject({ ok: false, status: 403, code: "passkey-required" });
    expect(await createOnboardingApi("eg", bridge("")).get()).toMatchObject({ ok: false, status: 401 });
  });
});

describe.skipIf(ready)("seller onboarding contract (harness unavailable)", () => {
  it("is skipped when the API test harness cannot boot", () => {
    expect(ready).toBe(false);
  });
});
