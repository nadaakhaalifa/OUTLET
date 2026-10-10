import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { money } from "../domain/bridge";
import { consumerParty, haul, sellerParty } from "./fixtures";
import { IDEM, STORE_A, STORE_B, TOKENS, U, bearer, createTaxHarness, type TaxHarness } from "./harness";

let h: TaxHarness;
let invoiceA: string;
let invoiceB: string;
let receipt: string;

beforeEach(async () => {
  h = await createTaxHarness();
  const mk = async (ref: string, store: string) => {
    const r = await h.issue.execute({
      kind: "seller_einvoice",
      sourceRef: ref,
      issuer: haul,
      recipient: sellerParty(store),
      lines: [{ lineType: "commission", descriptionAr: "عمولة", categoryCode: "marketplace_fee", amount: money(10_000n) }],
      storeId: store,
      userId: null,
    });
    if (r.kind !== "ok") throw new Error("issue");
    return r.value.stored.id;
  };
  invoiceA = await mk("a1", STORE_A);
  invoiceB = await mk("b1", STORE_B);
  const r = await h.issue.execute({
    kind: "shopper_ereceipt",
    sourceRef: "og-1",
    issuer: haul,
    recipient: consumerParty(U(1)),
    lines: [{ lineType: "delivery_fee", descriptionAr: "توصيل", categoryCode: "shipping", amount: money(11_400n) }],
    storeId: null,
    userId: U(1),
  });
  if (r.kind !== "ok") throw new Error("issue");
  receipt = r.value.stored.id;
});
afterEach(async () => {
  await h.close();
});

const EXEMPTION = {
  exemption: {
    reason_ar: "إعفاء بقرار وزاري",
    reason_en: "Ministerial exemption",
    legal_basis: "Decision 1/2026",
    effective_from: "2026-01-01T00:00:00.000Z",
    effective_to: null,
  },
  reason: "Finance ruling 2026-10",
  expected_version: 0,
};

describe("seller invoices", () => {
  it("lists only the caller's own invoices and never receipts", async () => {
    const res = await h.http().get("/v1/seller/invoices").set(bearer(TOKENS.ownerA));
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([invoiceA]);
    expect(res.body.items[0].totals.gross.amount).toBe("11400");
    expect(res.body.items[0].eta.state).toBe("QUEUED");
    expect(JSON.stringify(res.body)).not.toContain(U(1));
  });

  it("finance role of the same store can read; catalog role cannot", async () => {
    expect((await h.http().get("/v1/seller/invoices").set(bearer(TOKENS.financeA))).status).toBe(200);
    expect((await h.http().get("/v1/seller/invoices").set(bearer(TOKENS.catalogA))).status).toBe(403);
  });

  it("another store's invoice, a receipt and an unknown id are all 404", async () => {
    const own = await h.http().get(`/v1/seller/invoices/${invoiceA}`).set(bearer(TOKENS.ownerA));
    expect(own.status).toBe(200);
    for (const id of [invoiceB, receipt, U(404)]) {
      expect((await h.http().get(`/v1/seller/invoices/${id}`).set(bearer(TOKENS.ownerA))).status).toBe(404);
    }
    expect((await h.http().get(`/v1/seller/invoices/${invoiceA}`).set(bearer(TOKENS.ownerB))).status).toBe(404);
  });

  it("rejects anonymous, shopper and admin tokens", async () => {
    expect((await h.http().get("/v1/seller/invoices")).status).toBe(401);
    expect((await h.http().get("/v1/seller/invoices").set(bearer(TOKENS.shopper))).status).toBe(401);
    expect((await h.http().get("/v1/seller/invoices").set(bearer(TOKENS.adminFinance))).status).toBe(401);
  });

  it("validates the cursor", async () => {
    const res = await h.http().get("/v1/seller/invoices?cursor=%21%21").set(bearer(TOKENS.ownerA));
    expect(res.status).toBe(400);
  });
});

describe("admin tax console authorization", () => {
  const paths = ["/v1/admin/tax/categories", "/v1/admin/tax/documents", "/v1/admin/tax/exemption-audit", "/v1/admin/tax/reconciliation?date=2026-10-10"];

  it.each(paths)("%s: shopper and seller tokens are refused, anonymous is 401", async (p) => {
    expect((await h.http().get(p)).status).toBe(401);
    expect((await h.http().get(p).set(bearer(TOKENS.shopper))).status).toBe(401);
    expect((await h.http().get(p).set(bearer(TOKENS.ownerA))).status).toBe(401);
    expect((await h.http().get(p).set(bearer(TOKENS.buyerAudAdmin))).status).toBe(401);
    expect((await h.http().get(p).set(bearer(TOKENS.sellerAudAdmin))).status).toBe(401);
  });

  it.each(paths)("%s: support admin and a finance admin without a passkey get 403", async (p) => {
    expect((await h.http().get(p).set(bearer(TOKENS.adminSupport))).status).toBe(403);
    expect((await h.http().get(p).set(bearer(TOKENS.adminNoPasskey))).status).toBe(403);
  });

  it.each(paths)("%s: finance and ops can read", async (p) => {
    expect((await h.http().get(p).set(bearer(TOKENS.adminFinance))).status).toBe(200);
    expect((await h.http().get(p).set(bearer(TOKENS.adminOps))).status).toBe(200);
  });

  it("denials and allows are audited", async () => {
    await h.http().get("/v1/admin/tax/categories").set(bearer(TOKENS.adminSupport));
    await h.http().get("/v1/admin/tax/categories").set(bearer(TOKENS.adminFinance));
    const rows = h.audit.entries.filter((e) => e.ruleId === "tax_eta.admin");
    expect(rows.map((r) => r.effect)).toEqual(["deny", "allow"]);
  });

  it("ops can read but not change exemptions; support cannot", async () => {
    const put = (t: string) =>
      h.http().put("/v1/admin/tax/categories/shipping/exemption").set({ ...bearer(t), "Idempotency-Key": IDEM(1) }).send(EXEMPTION);
    expect((await put(TOKENS.adminOps)).status).toBe(403);
    expect((await put(TOKENS.adminSupport)).status).toBe(403);
    expect((await put(TOKENS.ownerA)).status).toBe(401);
  });

  it("admin documents list exposes the queue and a seller cannot see receipts through it", async () => {
    const res = await h.http().get("/v1/admin/tax/documents?state=QUEUED").set(bearer(TOKENS.adminFinance));
    expect(res.body.items).toHaveLength(3);
    const one = await h.http().get(`/v1/admin/tax/documents/${receipt}`).set(bearer(TOKENS.adminFinance));
    expect(one.body.recipient).toMatchObject({ kind: "consumer", legal_name_ar: null });
    expect((await h.http().get(`/v1/admin/tax/documents/${U(404)}`).set(bearer(TOKENS.adminFinance))).status).toBe(404);
  });
});

describe("exemption management", () => {
  const put = (code: string, body: unknown, key = IDEM(2)) =>
    h.http().put(`/v1/admin/tax/categories/${code}/exemption`).set({ ...bearer(TOKENS.adminFinance), "Idempotency-Key": key }).send(body as object);

  it("sets, audits, conflicts on a stale version and clears", async () => {
    const ok = await put("shipping", EXEMPTION);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ code: "shipping", version: 1, rate_bps: 1400 });
    expect(ok.body.exemption.legal_basis).toBe("Decision 1/2026");

    const stale = await put("shipping", EXEMPTION, IDEM(3));
    expect(stale.status).toBe(409);

    const audit = await h.http().get("/v1/admin/tax/exemption-audit?code=shipping").set(bearer(TOKENS.adminFinance));
    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0]).toMatchObject({ action: "exemption_set", actor_id: U(21), reason: "Finance ruling 2026-10" });

    const clear = await h
      .http()
      .post("/v1/admin/tax/categories/shipping/exemption/clear")
      .set({ ...bearer(TOKENS.adminFinance), "Idempotency-Key": IDEM(4) })
      .send({ reason: "Ruling withdrawn", expected_version: 1 });
    expect(clear.status).toBe(200);
    expect(clear.body.exemption).toBeNull();
    expect(clear.body.version).toBe(2);
  });

  it("validates Arabic text, the missing key and unknown categories", async () => {
    const english = await put("shipping", { ...EXEMPTION, exemption: { ...EXEMPTION.exemption, reason_ar: "Exempt" } });
    expect(english.status).toBe(422);
    const noKey = await h.http().put("/v1/admin/tax/categories/shipping/exemption").set(bearer(TOKENS.adminFinance)).send(EXEMPTION);
    expect(noKey.status).toBe(400);
    expect((await put("nope_cat", EXEMPTION, IDEM(5))).status).toBe(404);
    expect((await put("Bad Code", EXEMPTION, IDEM(6))).status).toBe(400);
    expect((await put("shipping", { ...EXEMPTION, extra: 1 }, IDEM(7))).status).toBe(400);
  });

  it("dead-letter requeue is finance only and only for dead-lettered rows", async () => {
    const post = (t: string, id: string, k: number) =>
      h.http().post(`/v1/admin/tax/submissions/${id}/requeue`).set({ ...bearer(t), "Idempotency-Key": IDEM(k) });
    expect((await post(TOKENS.adminFinance, invoiceA, 10)).status).toBe(409);
    expect((await post(TOKENS.adminOps, invoiceA, 11)).status).toBe(403);
    expect((await post(TOKENS.adminFinance, U(404), 12)).status).toBe(404);
  });
});
