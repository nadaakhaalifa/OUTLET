import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brandClient } from "@outlet/db";
import { PgAddressPort } from "../src/post-order-production.js";
import { T0, bearer } from "./harness.js";
import { createTestApp } from "./harness.js";
import type { TestApp } from "./harness.js";
import { authedHeaders } from "./flows.js";
import {
  VALID_IBAN, addressBody, courierEvents, createAddress, createReturn, deliveredOrder, geoIds, onboardingBody, ownerOfStoreA, paidOrder, returnBody, returnIn, sellerHeaders, shippedOrder, startOnboarding,
} from "./post-order-fixtures.js";
import { makePdf, makePng, multipartBody } from "./png.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const json = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;
const at = (offsetMs = 0): string => new Date(T0 + offsetMs).toISOString();

describe("addresses", () => {
  it("PgAddressPort resolves the owner's address with a content version that changes on edit, and nothing for anyone else", async () => {
    const s = await t.shopper();
    const other = await t.shopper();
    const a = await createAddress(t, s.token);
    const port = new PgAddressPort(brandClient<"outlet_app">(t.raw), "EG");
    const g = await geoIds(t);
    const r1 = await port.resolve(s.userId, a.id);
    expect(r1).toMatchObject({ geoAreaId: g.city, countryCode: "EG", codEligible: true });
    expect(r1?.version).toMatch(/^\d+$/);
    expect(await port.resolve(s.userId, a.id)).toEqual(r1);
    expect(await port.resolve(other.userId, a.id)).toBeNull();
    expect(await port.resolve(s.userId, "not-a-uuid")).toBeNull();
    // the test clock is frozen, so an edit is simulated by moving updated_at
    await t.raw.query("UPDATE addresses SET updated_at = updated_at + interval '1 second' WHERE id = $1", [a.id]);
    expect((await port.resolve(s.userId, a.id))?.version).not.toBe(r1?.version);
  });

  it("round-trips an address in contract shape (ids, e7 pin) and soft-deletes it", async () => {
    const s = await t.shopper();
    const created = await t.inject({ method: "POST", url: "/v1/eg/me/addresses", headers: authedHeaders(t, s.token), payload: await addressBody(t, { label: "البيت" }) });
    expect(created.statusCode).toBe(201);
    const a = json(created.body) as { id: string; is_default: boolean; fields: { governorate_id: string; district_id: string; landmark: string }; pin: { lat_e7: number }; geo_area_id: string; created_at: string };
    const g = await geoIds(t);
    expect(a.is_default).toBe(true);
    expect(a.fields.governorate_id).toBe(g.gov);
    expect(a.fields.district_id).toBe(g.city);
    expect(a.geo_area_id).toBe(g.city);
    expect(a.pin.lat_e7).toBe(300_500_000);
    expect(a.created_at).toMatch(/^\d{4}-/);
    const list = json((await t.inject({ method: "GET", url: "/v1/eg/me/addresses", headers: bearer(s.token) })).body) as { items: { id: string }[]; next_cursor: string | null };
    expect(list.items.map((i) => i.id)).toEqual([a.id]);
    expect((await t.inject({ method: "DELETE", url: `/v1/eg/me/addresses/${a.id}`, headers: authedHeaders(t, s.token) })).statusCode).toBe(204);
    expect((json((await t.inject({ method: "GET", url: "/v1/eg/me/addresses", headers: bearer(s.token) })).body) as { items: unknown[] }).items).toEqual([]);
  });

  it("422 for an area that is not in the geo tree or a city under another governorate; 400 for an unknown field", async () => {
    const s = await t.shopper();
    const body = (await addressBody(t)) as { fields: Record<string, string> };
    const bad = await t.inject({ method: "POST", url: "/v1/eg/me/addresses", headers: authedHeaders(t, s.token), payload: { ...body, fields: { ...body.fields, district_id: randomUUID() } } });
    expect(bad.statusCode).toBe(422);
    expect(json(bad.body).code).toBe("address-area-invalid");
    const extra = await t.inject({ method: "POST", url: "/v1/eg/me/addresses", headers: authedHeaders(t, s.token), payload: { ...body, is_admin: true } });
    expect(extra.statusCode).toBe(400);
  });

  it("make-default flips only the flag: the map pin and fields survive; an unparseable cursor is 400 cursor-invalid", async () => {
    const s = await t.shopper();
    const first = await createAddress(t, s.token);
    const second = await createAddress(t, s.token);
    const r = await t.inject({ method: "POST", url: `/v1/eg/me/addresses/${second.id}/default`, headers: authedHeaders(t, s.token) });
    expect(r.statusCode).toBe(200);
    const a = json(r.body) as { id: string; is_default: boolean; pin: { lat_e7: number }; fields: { landmark: string } };
    expect([a.id, a.is_default, a.pin.lat_e7]).toEqual([second.id, true, 300_500_000]);
    const list = json((await t.inject({ method: "GET", url: "/v1/eg/me/addresses", headers: bearer(s.token) })).body) as { items: { id: string; is_default: boolean }[] };
    expect(list.items.filter((i) => i.is_default).map((i) => i.id)).toEqual([second.id]);
    expect(list.items.map((i) => i.id)).toContain(first.id);
    const bad = await t.inject({ method: "GET", url: "/v1/eg/me/addresses?cursor=bm9wZQ", headers: bearer(s.token) });
    expect([bad.statusCode, json(bad.body).code]).toEqual([400, "cursor-invalid"]);
  });

  it("pages with an opaque cursor", async () => {
    const s = await t.shopper();
    for (let i = 0; i < 3; i++) await createAddress(t, s.token);
    const p1 = json((await t.inject({ method: "GET", url: "/v1/eg/me/addresses?limit=2", headers: bearer(s.token) })).body) as { items: { id: string }[]; next_cursor: string };
    expect(p1.items).toHaveLength(2);
    const p2 = json((await t.inject({ method: "GET", url: `/v1/eg/me/addresses?limit=2&cursor=${p1.next_cursor}`, headers: bearer(s.token) })).body) as { items: { id: string }[]; next_cursor: string | null };
    expect(p2.items).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
  });
});

describe("returns", () => {
  it("windows count from delivered_at: change of mind on day 15 is refused (422), a defect on day 29 is accepted", async () => {
    const late = await deliveredOrder(t, { daysAgo: 15 });
    const refused = await createReturn(t, late);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("return-window-closed");
    const defect = await deliveredOrder(t, { daysAgo: 29 });
    const ok = await createReturn(t, defect, { reason: "defective", evidence: [randomUUID()] });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe("APPROVED");
  });

  it("photos are required for defective and not-as-described (422), and unverifiable photos are refused (422)", async () => {
    const d = await deliveredOrder(t);
    expect((await createReturn(t, d, { reason: "not_as_described" })).body.code).toBe("return-photos-required");
    t.post.evidence.ready = false;
    try {
      const r = await createReturn(t, d, { reason: "defective", evidence: [randomUUID()] });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe("return-evidence-invalid");
    } finally {
      t.post.evidence.ready = true;
    }
  });

  it("an order that is not delivered cannot be returned (409); a foreign or mismatched line is 404", async () => {
    const shipped = await deliveredOrder(t, { status: "SHIPPED" });
    const r = await createReturn(t, shipped);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("not-delivered");
    const a = await deliveredOrder(t);
    const b = await deliveredOrder(t);
    const wrong = await t.inject({ method: "POST", url: `/v1/eg/seller-orders/${a.id}/returns`, headers: authedHeaders(t, a.token), payload: returnBody(b) });
    expect(wrong.statusCode).toBe(404);
  });

  it("the same Idempotency-Key replays one return; a second request for the same units is refused", async () => {
    const d = await deliveredOrder(t);
    const headers = authedHeaders(t, d.token);
    const first = await t.inject({ method: "POST", url: `/v1/eg/seller-orders/${d.id}/returns`, headers, payload: returnBody(d) });
    const replay = await t.inject({ method: "POST", url: `/v1/eg/seller-orders/${d.id}/returns`, headers, payload: returnBody(d) });
    expect(first.statusCode).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(json(replay.body)).toEqual(json(first.body));
    const again = await createReturn(t, d);
    expect(again.status).toBe(422);
    expect(again.body.code).toBe("return-qty-exceeds-purchased");
    expect((await t.raw.query("SELECT 1 FROM return_requests WHERE seller_order_id = $1", [d.id])).rows).toHaveLength(1);
  });

  it("a shopper cancels before pickup; after the parcel is in transit the cancel is 409", async () => {
    const r = await returnIn(t, "APPROVED");
    const ok = await t.inject({ method: "POST", url: `/v1/eg/returns/${r.returnId}/cancel`, headers: authedHeaders(t, r.d.token), payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(json(ok.body).status).toBe("CANCELLED");
    const moving = await returnIn(t, "IN_TRANSIT");
    const no = await t.inject({ method: "POST", url: `/v1/eg/returns/${moving.returnId}/cancel`, headers: authedHeaders(t, moving.d.token), payload: {} });
    expect(no.statusCode).toBe(409);
    expect((await t.raw.query<{ status: string }>("SELECT status FROM return_requests WHERE id = $1", [moving.returnId])).rows[0]?.status).toBe("IN_TRANSIT");
  });

  it("a dispute needs a rejected return (409 otherwise), opens with an SLA, and refuses evidence files it cannot store", async () => {
    const approved = await returnIn(t, "APPROVED");
    const conflict = await t.inject({ method: "POST", url: `/v1/eg/returns/${approved.returnId}/dispute`, headers: authedHeaders(t, approved.d.token), payload: { statement: "x" } });
    expect(conflict.statusCode).toBe(409);
    const rejected = await returnIn(t, "REJECTED");
    const withFiles = await t.inject({ method: "POST", url: `/v1/eg/returns/${rejected.returnId}/dispute`, headers: authedHeaders(t, rejected.d.token), payload: { statement: "x", media_ids: [randomUUID()] } });
    expect(withFiles.statusCode).toBe(422);
    const ok = await t.inject({ method: "POST", url: `/v1/eg/returns/${rejected.returnId}/dispute`, headers: authedHeaders(t, rejected.d.token), payload: { statement: "المنتج كما وصفته" } });
    expect(ok.statusCode).toBe(201);
    const d = json(ok.body) as { status: string; sla_due_at: string };
    expect(d.status).toBe("OPEN");
    expect(Date.parse(d.sla_due_at)).toBeGreaterThan(T0);
    expect((await t.raw.query<{ status: string }>("SELECT status FROM return_requests WHERE id = $1", [rejected.returnId])).rows[0]?.status).toBe("DISPUTED");
  });

  it("seller inspection: only RECEIVED returns (409), a rejection records a reason, the shopper sees the verdict; support role cannot inspect (403)", async () => {
    const early = await returnIn(t, "APPROVED");
    const { token } = await t.seller(t.seed.storeA, ["warehouse"]);
    const item = (await t.raw.query<{ id: string }>("SELECT id FROM return_items WHERE return_request_id = $1", [early.returnId])).rows[0]?.id ?? "";
    const lines = [{ return_line_id: item, condition_received: "used", restock_decision: "write_off" }];
    const notYet = await t.inject({ method: "POST", url: `/v1/eg/seller/returns/${early.returnId}/inspect`, headers: sellerHeaders(t, token, t.seed.storeA), payload: { result: "accepted", lines } });
    expect(notYet.statusCode).toBe(409);
    const received = await returnIn(t, "RECEIVED");
    const itemId = (await t.raw.query<{ id: string }>("SELECT id FROM return_items WHERE return_request_id = $1", [received.returnId])).rows[0]?.id ?? "";
    const rej = await t.inject({
      method: "POST", url: `/v1/eg/seller/returns/${received.returnId}/inspect`, headers: sellerHeaders(t, token, t.seed.storeA),
      payload: { result: "rejected", notes: "worn", lines: [{ return_line_id: itemId, condition_received: "used", restock_decision: "write_off" }] },
    });
    expect(rej.statusCode).toBe(200);
    expect(json(rej.body).status).toBe("REJECTED");
    const mine = json((await t.inject({ method: "GET", url: `/v1/eg/returns/${received.returnId}`, headers: bearer(received.d.token) })).body) as { status: string; lines: { condition_received: string }[] };
    expect(mine.status).toBe("REJECTED");
    expect(mine.lines[0]?.condition_received).toBe("used");
    const support = await t.seller(t.seed.storeA, ["support"]);
    const denied = await t.inject({ method: "POST", url: `/v1/eg/seller/returns/${received.returnId}/inspect`, headers: sellerHeaders(t, support.token, t.seed.storeA), payload: { result: "accepted", lines: [] } });
    expect(denied.statusCode).toBe(403);
  });

  it("the seller list shows only this store's returns", async () => {
    const mine = await returnIn(t, "APPROVED", t.seed.storeA);
    const theirs = await returnIn(t, "APPROVED", t.seed.storeB);
    const { token } = await t.seller(t.seed.storeA, ["warehouse"]);
    const list = json((await t.inject({ method: "GET", url: "/v1/eg/seller/returns?limit=50", headers: { ...bearer(token), "x-store-id": t.seed.storeA } })).body) as { items: { id: string }[] };
    const ids = list.items.map((i) => i.id);
    expect(ids).toContain(mine.returnId);
    expect(ids).not.toContain(theirs.returnId);
  });
});

describe("order cancellation (before shipping only)", () => {
  it("answers 503 while the cancellation saga is unconfigured and changes nothing", async () => {
    const o = await paidOrder(t);
    const r = await t.inject({ method: "POST", url: `/v1/eg/order-groups/${o.groupId}/cancel`, headers: authedHeaders(t, o.token), payload: { reason_code: "changed_mind" } });
    expect(r.statusCode).toBe(503);
    expect(json(r.body).code).toBe("order-cancellation-unconfigured");
    expect((await t.raw.query<{ status: string }>("SELECT status FROM seller_orders WHERE id = $1", [o.sellerOrderId])).rows[0]?.status).toBe("PAID");
  });

  it("is 409 once any store has shipped, and never reaches the port", async () => {
    t.post.cancellation.calls.length = 0;
    for (const status of ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]) {
      const o = await paidOrder(t, status);
      const r = await t.inject({ method: "POST", url: `/v1/eg/order-groups/${o.groupId}/cancel`, headers: authedHeaders(t, o.token), payload: { reason_code: "changed_mind" } });
      expect(r.statusCode, status).toBe(409);
      expect(json(r.body).code).toBe("cancel-after-shipping");
    }
    expect(t.post.cancellation.calls).toHaveLength(0);
  });

  it("calls the port exactly once for an eligible order when the saga is wired", async () => {
    const o = await paidOrder(t);
    t.post.cancellation.unconfigured = false;
    try {
      const r = await t.inject({ method: "POST", url: `/v1/eg/order-groups/${o.groupId}/cancel`, headers: authedHeaders(t, o.token), payload: { reason_code: "changed_mind", refund_preference: "original" } });
      expect(r.statusCode).toBe(200);
      expect(t.post.cancellation.calls).toEqual([{ userId: o.userId, orderGroupId: o.groupId, reasonCode: "changed_mind", refundPreference: "original" }]);
    } finally {
      t.post.cancellation.unconfigured = true;
    }
  });
});

describe("tracking and the courier webhook", () => {
  it("shows normalised shipment state only (no courier raw data)", async () => {
    const s = await shippedOrder(t);
    const r = await t.inject({ method: "GET", url: `/v1/eg/order-groups/${s.groupId}/tracking`, headers: bearer(s.token) });
    expect(r.statusCode).toBe(200);
    const body = json(r.body) as { shipments: { status: string; awb: string; latest_event: { status: string } | null }[] };
    expect(body.shipments).toHaveLength(1);
    expect(body.shipments[0]).toMatchObject({ status: "IN_TRANSIT", awb: s.awb });
    expect(r.body).not.toMatch(/raw|payload|body_ct/i);
  });

  it("a bad signature is 401, stores the body flagged and changes no shipment state", async () => {
    const s = await shippedOrder(t);
    const before = (await t.raw.query("SELECT count(*)::int AS n FROM courier_events_raw WHERE processing_status = 'rejected'")).rows[0] as { n: number };
    const res = await t.inject(courierEvents([{ eventId: `e-${randomUUID()}`, awb: s.awb, rawStatus: "delivered", occurredAt: at() }], { "x-signature": "forged", "x-timestamp": at() }));
    expect(res.statusCode).toBe(401);
    expect(json(res.body).code).toBe("webhook-signature-invalid");
    expect((await t.raw.query<{ status: string }>("SELECT status FROM shipments WHERE id = $1", [s.shipmentId])).rows[0]?.status).toBe("IN_TRANSIT");
    expect((await t.raw.query<{ status: string }>("SELECT status FROM seller_orders WHERE id = $1", [s.id])).rows[0]?.status).toBe("SHIPPED");
    const after = (await t.raw.query("SELECT count(*)::int AS n FROM courier_events_raw WHERE processing_status = 'rejected'")).rows[0] as { n: number };
    expect(after.n).toBe(before.n + 1);
  });

  it("a stale timestamp is refused like a bad signature", async () => {
    const s = await shippedOrder(t);
    const res = await t.inject(courierEvents([{ eventId: `e-${randomUUID()}`, awb: s.awb, rawStatus: "delivered", occurredAt: at() }], { "x-signature": "valid", "x-timestamp": at(-10 * 60_000) }));
    expect(res.statusCode).toBe(401);
    expect((await t.raw.query<{ status: string }>("SELECT status FROM shipments WHERE id = $1", [s.shipmentId])).rows[0]?.status).toBe("IN_TRANSIT");
  });

  it("delivery marks the shipment and the order DELIVERED; replaying the same events changes nothing and says duplicate", async () => {
    const s = await shippedOrder(t);
    const req = courierEvents([
      { eventId: `a-${randomUUID()}`, awb: s.awb, rawStatus: "out_for_delivery", occurredAt: at(1000) },
      { eventId: `b-${randomUUID()}`, awb: s.awb, rawStatus: "delivered", occurredAt: at(2000) },
    ]);
    const first = await t.inject(req);
    expect(first.statusCode).toBe(200);
    expect(json(first.body)).toEqual({ received: true, duplicate: false });
    const snapshot = async (): Promise<string> => JSON.stringify([(await t.raw.query("SELECT status, attempts, delivered_at, version FROM shipments WHERE id = $1", [s.shipmentId])).rows, (await t.raw.query("SELECT status, delivered_at FROM seller_orders WHERE id = $1", [s.id])).rows]);
    const once = await snapshot();
    expect(once).toContain("DELIVERED");
    const replay = await t.inject(req);
    expect(replay.statusCode).toBe(200);
    expect(json(replay.body)).toEqual({ received: true, duplicate: true });
    expect(await snapshot()).toBe(once);
    const tracked = json((await t.inject({ method: "GET", url: `/v1/eg/order-groups/${s.groupId}/tracking`, headers: bearer(s.token) })).body) as { shipments: { status: string; delivered_at: string }[] };
    expect(tracked.shipments[0]?.status).toBe("DELIVERED");
  });

  it("an unknown courier code is 404; a source address outside the allow-list is the same 404 (couriers are not enumerable); an oversized body is 413; credentials are not needed", async () => {
    expect((await t.inject({ method: "POST", url: "/v1/eg/webhooks/couriers/other", headers: { "content-type": "application/json" }, payload: "{}" })).statusCode).toBe(404);
    const denied = await t.inject({ ...courierEvents([]), remoteAddress: "10.9.9.9" });
    expect(denied.statusCode).toBe(404);
    const big = await t.inject({ method: "POST", url: "/v1/eg/webhooks/couriers/fake", headers: { "content-type": "application/json", "x-signature": "valid" }, payload: JSON.stringify({ events: [], pad: "x".repeat(300_000) }) });
    expect(big.statusCode).toBe(413);
  });
});

describe("seller application", () => {
  it("needs a phishing-resistant session (403 passkey-required with an OTP-only token)", async () => {
    const s = await t.shopper();
    const r = await t.inject({ method: "POST", url: "/v1/eg/seller/onboarding", headers: authedHeaders(t, s.token), payload: onboardingBody() });
    expect(r.statusCode).toBe(403);
    expect(json(r.body).code).toBe("passkey-required");
  });

  it("starts a draft, lists the gaps, and refuses a duplicate commercial register number (409)", async () => {
    const s = await t.shopper();
    const token = await t.mint({ userId: s.userId, amr: ["otp", "passkey"] });
    const body = onboardingBody();
    const created = await t.inject({ method: "POST", url: "/v1/eg/seller/onboarding", headers: authedHeaders(t, token), payload: body });
    expect(created.statusCode).toBe(201);
    const state = json((await t.inject({ method: "GET", url: "/v1/eg/seller/onboarding", headers: bearer(token) })).body) as { status: string; gaps: string[]; required_documents: string[] };
    expect(state.status).toBe("DRAFT");
    expect(state.gaps).toEqual(expect.arrayContaining(["document:commercial_register", "bank_account"]));
    expect(state.required_documents).toContain("tax_card");
    const other = await t.shopper();
    const dup = await t.inject({ method: "POST", url: "/v1/eg/seller/onboarding", headers: authedHeaders(t, await t.mint({ userId: other.userId, amr: ["otp", "passkey"] })), payload: body });
    expect(dup.statusCode).toBe(409);
  });

  it("stores the IBAN encrypted and never echoes it: only the last four characters leave the API", async () => {
    const s = await startOnboarding(t);
    const r = await t.inject({ method: "PUT", url: "/v1/eg/seller/onboarding/bank-account", headers: authedHeaders(t, s.token), payload: { iban: VALID_IBAN, account_name: "شركة النور للتجارة" } });
    expect(r.statusCode).toBe(200);
    expect(json(r.body)).toEqual({ iban_last4: VALID_IBAN.slice(-4) });
    const state = await t.inject({ method: "GET", url: "/v1/eg/seller/onboarding", headers: bearer(s.token) });
    expect(state.body).not.toContain(VALID_IBAN);
    const row = (await t.raw.query<{ iban_ct: Uint8Array; iban_last4: string }>("SELECT iban_ct, iban_last4 FROM seller_bank_accounts WHERE seller_id = (SELECT seller_id FROM kyc_cases WHERE applicant_user_id = $1)", [s.userId])).rows[0];
    expect(row?.iban_last4).toBe(VALID_IBAN.slice(-4));
    expect(Buffer.from(row?.iban_ct ?? []).toString("utf8")).not.toContain(VALID_IBAN);
    expect(t.logs.join("\n")).not.toContain(VALID_IBAN);
    const bad = await t.inject({ method: "PUT", url: "/v1/eg/seller/onboarding/bank-account", headers: authedHeaders(t, s.token), payload: { iban: "EG000000000000000000000000000", account_name: "x" } });
    expect(bad.statusCode).toBe(422);
  });

  it("uploads a KYC document as a scanned PDF (media kind document) and attaches it; an image is refused", async () => {
    const s = await startOnboarding(t);
    const form = multipartBody({ doc_type: "tax_card" }, { name: "tax.pdf", type: "application/pdf", data: makePdf() });
    const ok = await t.inject({ method: "POST", url: "/v1/eg/seller/onboarding/documents", headers: { ...authedHeaders(t, s.token), "content-type": form.contentType }, payload: form.payload });
    expect(ok.statusCode).toBe(201);
    const doc = json(ok.body) as { media_id: string; doc_type: string };
    const media = (await t.raw.query<{ kind: string; status: string; created_by: string }>("SELECT kind, status, created_by FROM media_assets WHERE id = $1", [doc.media_id])).rows[0];
    expect(media).toEqual({ kind: "document", status: "ready", created_by: s.userId });
    const state = json((await t.inject({ method: "GET", url: "/v1/eg/seller/onboarding", headers: bearer(s.token) })).body) as { gaps: string[] };
    expect(state.gaps).not.toContain("document:tax_card");
    const img = multipartBody({ doc_type: "tax_card" }, { name: "tax.png", type: "image/png", data: makePng() });
    const no = await t.inject({ method: "POST", url: "/v1/eg/seller/onboarding/documents", headers: { ...authedHeaders(t, s.token), "content-type": img.contentType }, payload: img.payload });
    expect(no.statusCode).toBe(422);
  });

  it("submission is refused with the list of gaps (422) and the case stays DRAFT", async () => {
    const s = await startOnboarding(t);
    const r = await t.inject({ method: "POST", url: "/v1/eg/seller/onboarding/submit", headers: authedHeaders(t, s.token), payload: {} });
    expect(r.statusCode).toBe(422);
    const body = json(r.body) as { code: string; errors: { code: string }[] };
    expect(body.code).toBe("kyc-incomplete");
    expect(body.errors.map((e) => e.code)).toContain("bank_account");
    expect((await t.raw.query<{ state: string }>("SELECT state FROM kyc_cases WHERE applicant_user_id = $1", [s.userId])).rows[0]?.state).toBe("DRAFT");
  });

  it("another applicant cannot read or change my application (they have their own, or none: 404)", async () => {
    await startOnboarding(t);
    const stranger = await t.shopper();
    const token = await t.mint({ userId: stranger.userId, amr: ["otp", "passkey"] });
    expect((await t.inject({ method: "GET", url: "/v1/eg/seller/onboarding", headers: bearer(token) })).statusCode).toBe(404);
    expect((await t.inject({ method: "PUT", url: "/v1/eg/seller/onboarding/bank-account", headers: authedHeaders(t, token), payload: { iban: VALID_IBAN, account_name: "x" } })).statusCode).toBe(404);
    const before = Number((await t.raw.query<{ n: string }>("SELECT count(*)::text n FROM media_assets WHERE created_by = $1", [stranger.userId])).rows[0]?.n);
    const form = multipartBody({ doc_type: "tax_card" }, { name: "tax.pdf", type: "application/pdf", data: makePdf() });
    expect((await t.inject({ method: "POST", url: "/v1/eg/seller/onboarding/documents", headers: { ...authedHeaders(t, token), "content-type": form.contentType }, payload: form.payload })).statusCode).toBe(404);
    expect(Number((await t.raw.query<{ n: string }>("SELECT count(*)::text n FROM media_assets WHERE created_by = $1", [stranger.userId])).rows[0]?.n)).toBe(before);
  });
});

describe("store team", () => {
  it("an owner invites by phone; the invite appears in the member list and never carries the contact", async () => {
    const o = await ownerOfStoreA(t);
    const r = await t.inject({ method: "POST", url: "/v1/eg/seller/store/invites", headers: sellerHeaders(t, o.token, t.seed.storeA), payload: { contact: "+201066660001", role_code: "finance" } });
    expect(r.statusCode).toBe(201);
    const inv = json(r.body) as { id: string; role_code: string; expires_at: string };
    expect(inv.role_code).toBe("finance");
    expect(Date.parse(inv.expires_at)).toBeGreaterThan(T0);
    const list = await t.inject({ method: "GET", url: "/v1/eg/seller/store/members?limit=50", headers: { ...bearer(o.token), "x-store-id": t.seed.storeA } });
    const members = (json(list.body) as { items: { id: string; status: string }[] }).items;
    expect(members.find((m) => m.id === inv.id)?.status).toBe("invited");
    expect(list.body).not.toContain("66660001");
  });

  it("the owner role cannot be invited (400) and a token-only owner without a database membership cannot invite (404)", async () => {
    const o = await ownerOfStoreA(t);
    const own = await t.inject({ method: "POST", url: "/v1/eg/seller/store/invites", headers: sellerHeaders(t, o.token, t.seed.storeA), payload: { contact: "+201066660002", role_code: "owner" } });
    expect(own.statusCode).toBe(400);
    const ghost = await t.seller(t.seed.storeA, ["owner"]);
    const r = await t.inject({ method: "POST", url: "/v1/eg/seller/store/invites", headers: sellerHeaders(t, ghost.token, t.seed.storeA), payload: { contact: "+201066660003", role_code: "support" } });
    expect(r.statusCode).toBe(404);
  });
});
