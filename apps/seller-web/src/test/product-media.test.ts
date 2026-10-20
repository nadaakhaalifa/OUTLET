import { describe, expect, it } from "vitest";
import { createSellerApi } from "../api/client";
import type { ProductMediaSummary } from "../api/schemas-phase3";
import { createTranslator } from "../i18n";
import type { Ctx } from "../loaders";
import { loadProductMedia } from "../loaders-phase2";
import { FakeSession } from "../session/fake";
import { navFor } from "../view-models/nav";
import { permissionsFor } from "./permissions";
import { isMediaFile, mediaErrorKey, mediaRows, RELAYED_TYPES } from "../view-models/product-media";
import { fakeTransport, json, UUID_A, UUID_B } from "./fake-transport";

const NOW = Date.parse("2026-10-12T10:00:00Z");
const TS = "2026-10-12T09:00:00Z";
const mk = (o: Partial<ProductMediaSummary> = {}): ProductMediaSummary => ({
  id: UUID_B, store_id: UUID_A, status: "READY", decision: "none", requested_model: "u2netp", model_id: "u2netp", quality_score: 82,
  quality_reasons: ["white_on_white_risk"], error_code: null, attempts: 1, version: 2, created_at: TS, updated_at: TS, ...o,
});
const ctx = (routes: Parameters<typeof fakeTransport>[0]): Ctx => {
  const transport = fakeTransport(routes);
  const session = new FakeSession({ initial: { accessToken: "t", refreshToken: "r", accessExpiresAtMs: NOW + 600_000, secondFactorRequired: false } });
  let n = 0;
  return { api: createSellerApi({ transport, session, newIdempotencyKey: () => `k-${(n += 1)}` }), locale: "en", role: null, nowMs: NOW };
};
const store = { id: UUID_A, slug: "s", name: { ar: "متجر" }, status: "active", legal_identity: { legal_name: "L" }, kyc_status: "APPROVED" };
const STORE = { "GET /v1/seller/store": () => json(store) };

describe("mediaRows", () => {
  it("READY with no decision can be accepted, kept original or re-run with another model", () => {
    const [r] = mediaRows([mk()], "en");
    expect(r).toMatchObject({ canDecide: true, canRerun: true, scoreGood: true, hasCutout: true });
    expect(r?.otherModels).not.toContain("u2netp");
    expect(r?.reasonKeys).toEqual(["media.reason.white_on_white_risk"]);
  });
  it("unknown reason codes collapse to one generic line and low scores ask for a check", () => {
    const [r] = mediaRows([mk({ status: "NEEDS_REVIEW", quality_score: 40, quality_reasons: ["secret_internal_code"] })], "en");
    expect(r?.reasonKeys).toEqual(["media.reason.other"]);
    expect(r?.scoreGood).toBe(false);
  });
  it("FAILED offers a retry but no accept; decided photos cannot be decided twice; 5 runs is the cap", () => {
    expect(mediaRows([mk({ status: "FAILED", quality_score: null, quality_reasons: [] })], "en")[0]).toMatchObject({ canDecide: false, canRerun: true, hasCutout: false });
    expect(mediaRows([mk({ decision: "accepted" })], "en")[0]?.canDecide).toBe(false);
    expect(mediaRows([mk({ attempts: 5 })], "en")[0]?.canRerun).toBe(false);
    expect(mediaRows([mk({ status: "PROCESSING" })], "en")[0]).toMatchObject({ canDecide: false, canRerun: false });
  });
  it("shows 'Attached to product' once the photo backs a product, and not before", () => {
    const [free] = mediaRows([mk({ decision: "accepted" })], "en");
    expect(free).toMatchObject({ attached: false, attachedProductId: null });
    const [linked] = mediaRows([mk({ decision: "accepted", attached_product_id: UUID_A })], "en");
    expect(linked).toMatchObject({ attached: true, attachedProductId: UUID_A });
    expect(createTranslator("en")("media.attached")).toBe("Attached to product");
    expect(createTranslator("ar")("media.attached")).not.toBe("media.attached");
    // An older API build that omits the field is treated as free.
    expect(mediaRows([mk()], "en")[0]?.attached).toBe(false);
  });
  it("only allows known files and image types through the relay", () => {
    expect(isMediaFile("png") && isMediaFile("original") && isMediaFile("white_jpg")).toBe(true);
    expect(isMediaFile("shadow") || isMediaFile("../x")).toBe(false);
    expect(RELAYED_TYPES.has("image/svg+xml") || RELAYED_TYPES.has("text/html")).toBe(false);
  });
  it("every produced key exists in both catalogs", () => {
    const en = createTranslator("en"), ar = createTranslator("ar");
    for (const r of mediaRows([mk(), mk({ status: "FAILED" }), mk({ quality_reasons: ["zzz"] })], "en")) {
      for (const k of [r.statusKey, r.decisionKey, ...r.reasonKeys]) { expect(en(k)).not.toBe(k); expect(ar(k)).not.toBe(k); }
    }
  });
});

describe("loader and errors", () => {
  const P = `GET /v1/seller/stores/${UUID_A}/product-media`;
  it("lists jobs for the store", async () => {
    const s = await loadProductMedia(ctx({ ...STORE, [P]: () => json({ items: [mk()] }) }));
    expect(s.kind === "ready" && !s.data.unavailable && s.data.rows.length).toBe(1);
  });
  it("503 reads as 'not available yet', not an error", async () => {
    const s = await loadProductMedia(ctx({ ...STORE, [P]: () => json({ type: "about:blank", title: "x", status: 503, code: "background_removal_disabled" }, 503) }));
    expect(s.kind === "ready" && s.data.unavailable).toBe(true);
  });
  it("maps 503, 429 and attempts to plain messages", () => {
    expect(mediaErrorKey({ kind: "server", status: 503, code: "provider_not_configured" })).toBe("media.err.unavailable");
    expect(mediaErrorKey({ kind: "rate_limited", status: 429, code: "quota_exceeded" })).toBe("media.err.quota");
    expect(mediaErrorKey({ kind: "conflict", status: 409, code: "attempts_exceeded" })).toBe("media.err.attempts");
  });
  it("nav lists the page by store_product.read, not by role name", () => {
    expect(navFor(permissionsFor("catalog")).map((n) => n.href)).toContain("/media");
    expect(navFor(permissionsFor("catalog", ["store_product.read"])).map((n) => n.href)).not.toContain("/media");
  });
});
