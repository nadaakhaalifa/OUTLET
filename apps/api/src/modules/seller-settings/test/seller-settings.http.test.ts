import { sellerSettings as ss } from "@outlet/domain";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SettingsPayoutAccountAdapter } from "../application/service";
import { STORE_A, STORE_B, U, createHarness, plainUser, seller, type Harness } from "./harness";

const T = {
  ownerA: "tok-owner-a-0000000001",
  managerA: "tok-manager-a-00000001",
  financeA: "tok-finance-a-00000001",
  catalogA: "tok-catalog-a-00000001",
  warehouseA: "tok-warehouse-a-0000001",
  supportA: "tok-support-a-00000001",
  noWriteA: "tok-owner-a-readonly-001",
  ownerB: "tok-owner-b-0000000001",
  suspendedA: "tok-suspended-a-0000001",
  shopper: "tok-shopper-0000000001",
  buyerAud: "tok-owner-a-buyer-aud-01",
  invitee: "tok-invitee-000000000001",
  stranger: "tok-stranger-0000000001",
};
const USERS = { ownerA: U(21), managerA: U(22), financeA: U(23), catalogA: U(24), invitee: U(60), stranger: U(61), ownerB: U(26) };

let h: Harness;
let k = 5000;
const key = (): string => U(k++);
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

/** Valid Egyptian IBAN: EG + 2 check digits + 25 digits, mod 97 equals 1. */
function iban(body25: string): string {
  const digits = `${body25}1416` + "00";
  let rem = 0;
  for (const c of digits) rem = (rem * 10 + Number(c)) % 97;
  return `EG${String(98 - rem).padStart(2, "0")}${body25}`;
}
const IBAN_1 = iban("1234567890123456789012345");
const IBAN_2 = iban("5432109876543210987654321");

const get = (p: string, t: string | null) => (t === null ? h.http().get(p) : h.http().get(p).set(bearer(t)));
const send = (m: "post" | "put" | "patch" | "delete", p: string, t: string | null, body?: object, idem: string | null = key()) => {
  let r = h.http()[m](p);
  if (t !== null) r = r.set(bearer(t));
  if (idem !== null) r = r.set("Idempotency-Key", idem);
  return r.send(body ?? {});
};
const base = (s = STORE_A): string => `/v1/seller/stores/${s}`;

const profileBody = (over: Record<string, unknown> = {}) => ({
  name_ar: "متجر النور",
  name_en: "Al Nour",
  description_ar: "ملابس",
  social_links: { instagram: "https://www.instagram.com/alnour" },
  return_policy: { change_of_mind_days: 14, defect_days: 30, text_ar: "سياسة", text_en: "Policy" },
  free_delivery_threshold: { amount: "200000", currency: "EGP" },
  ...over,
});

const png = (w: number, hgt: number): Buffer => {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(hgt, 20);
  return b;
};

beforeEach(async () => {
  if (h !== undefined) await h.close();
  h = await createHarness();
  h.tokens.add(T.ownerA, seller(USERS.ownerA, STORE_A, "owner"));
  h.tokens.add(T.managerA, seller(USERS.managerA, STORE_A, "manager"));
  h.tokens.add(T.financeA, seller(USERS.financeA, STORE_A, "finance"));
  h.tokens.add(T.catalogA, seller(USERS.catalogA, STORE_A, "catalog"));
  h.tokens.add(T.warehouseA, seller(U(25), STORE_A, "warehouse"));
  h.tokens.add(T.supportA, seller(U(27), STORE_A, "support"));
  h.tokens.add(T.noWriteA, seller(U(28), STORE_A, "owner", ["seller:read"]));
  h.tokens.add(T.ownerB, seller(USERS.ownerB, STORE_B, "owner"));
  h.tokens.add(T.suspendedA, { ...seller(U(29), STORE_A, "owner"), status: "suspended" });
  h.tokens.add(T.shopper, plainUser(U(30)));
  h.tokens.add(T.buyerAud, seller(USERS.ownerA, STORE_A, "owner"), "buyer_api");
  h.tokens.add(T.invitee, plainUser(USERS.invitee));
  h.tokens.add(T.stranger, plainUser(USERS.stranger));
  h.members.seed(STORE_A, { userId: USERS.ownerA, role: "owner", phoneE164: "+201000000001", joinedAtMs: 1 });
  h.members.seed(STORE_A, { userId: USERS.managerA, role: "manager", phoneE164: "+201000000002", joinedAtMs: 2 });
  h.members.phones.set(USERS.invitee, "+201012345678");
  h.members.phones.set(USERS.stranger, "+201099999999");
});
afterAll(async () => {
  if (h !== undefined) await h.close();
});

/** Every route: unauthenticated 401, wrong audience 401, suspended 403, shopper 403, other store 404. */
const ROUTES: readonly (readonly ["get" | "post" | "put" | "patch" | "delete", string])[] = [
  ["get", "/profile"],
  ["put", "/profile"],
  ["put", "/vacation"],
  ["get", "/storefront-preview"],
  ["post", "/media/uploads"],
  ["post", `/media/uploads/${U(1)}/confirm`],
  ["post", "/media/product-uploads"],
  ["get", "/payout-account"],
  ["put", "/payout-account"],
  ["get", "/payout-account/history"],
  ["get", "/shipping"],
  ["put", "/shipping"],
  ["get", "/notification-preferences"],
  ["put", "/notification-preferences"],
  ["get", "/team"],
  ["post", "/team/invites"],
  ["delete", `/team/invites/${U(1)}`],
  ["patch", `/team/members/${U(2)}`],
  ["delete", `/team/members/${U(2)}`],
  ["get", "/eta-enrolment"],
  ["post", "/eta-enrolment/request"],
  ["post", "/eta-enrolment/revoke"],
];

describe("authorization on every store-scoped route", () => {
  it.each(ROUTES)("%s %s", async (method, path) => {
    const url = base() + path;
    const call = (t: string | null, store = STORE_A) => (method === "get" ? get(base(store) + path, t) : send(method, base(store) + path, t, {}));
    expect((await call(null)).status).toBe(401);
    expect((await call(T.buyerAud)).status).toBe(401);
    expect((await call(T.suspendedA)).status).toBe(403);
    expect([403, 404]).toContain((await call(T.shopper)).status);
    // Another store's owner: identical to a store that does not exist.
    const foreign = await call(T.ownerB);
    const missing = await call(T.ownerB, U(0xdead));
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ ...missing.body, request_id: foreign.body.request_id });
    expect(url).toContain(STORE_A);
  });
});

describe("store profile", () => {
  it("reads defaults from the approved store and enforces role split", async () => {
    const r = await get(`${base()}/profile`, T.ownerA);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name_ar: "متجر النور", free_delivery_threshold: { amount: "200000", currency: "EGP" }, version: 0 });
    expect(r.body.return_policy.statutory_minimum).toEqual({ change_of_mind_days: 14, defect_days: 30 });
    expect((await get(`${base()}/profile`, T.managerA)).status).toBe(200);
    for (const t of [T.catalogA, T.warehouseA, T.supportA, T.financeA]) expect((await get(`${base()}/profile`, t)).status).toBe(403);
  });

  it("another store's settings are 404 for a read-write token", async () => {
    expect((await get(`${base(STORE_B)}/profile`, T.ownerA)).status).toBe(404);
    expect((await send("put", `${base(STORE_B)}/profile`, T.ownerA, profileBody())).status).toBe(404);
  });

  it("saves, bumps version and projects to the preview with the B5 legal identity", async () => {
    const put = await send("put", `${base()}/profile`, T.managerA, profileBody({ free_delivery_threshold: { amount: "300000", currency: "EGP" } }));
    expect(put.status).toBe(200);
    expect(put.body.version).toBe(1);
    const again = await send("put", `${base()}/profile`, T.ownerA, profileBody());
    expect(again.body.version).toBe(2);
    const p = await get(`${base()}/storefront-preview`, T.ownerA);
    expect(p.body).toMatchObject({
      slug: "nour",
      accepting_orders: true,
      handling_time_hours: 48,
      legal_identity: { legal_name: "شركة النور للملابس", commercial_register_no: "12345", tax_card_no: "999-888-777", governorate_code: "EG-C" },
      social_links: { instagram: "https://www.instagram.com/alnour" },
    });
    expect(JSON.stringify(p.body)).not.toMatch(/iban|phone|member/i);
  });

  it("refuses less than the statutory return windows, English-only policy and a threshold above the admin max", async () => {
    const bad = async (over: Record<string, unknown>, code: string) => {
      const r = await send("put", `${base()}/profile`, T.ownerA, profileBody(over));
      expect(r.status, code).toBe(422);
      expect(r.body.code).toBe(code);
    };
    await bad({ return_policy: { change_of_mind_days: 13, defect_days: 30 } }, "return_window_below_statutory_minimum");
    await bad({ return_policy: { change_of_mind_days: 14, defect_days: 29 } }, "defect_window_below_statutory_minimum");
    await bad({ return_policy: { change_of_mind_days: 14, defect_days: 30, text_en: "English only" } }, "return_policy_arabic_required");
    await bad({ name_ar: "English only" }, "name_ar_must_be_arabic");
    await bad({ free_delivery_threshold: { amount: "500001", currency: "EGP" } }, "threshold_above_admin_max");
    await bad({ social_links: { instagram: "https://evil.example.com/x" } }, "social_link_wrong_host");
  });

  it("rejects mass assignment, missing idempotency key and a read-only token", async () => {
    expect((await send("put", `${base()}/profile`, T.ownerA, { ...profileBody(), logo_key: "stores/x/logo.png" })).status).toBe(400);
    expect((await send("put", `${base()}/profile`, T.ownerA, profileBody(), null)).status).toBe(400);
    expect((await send("put", `${base()}/profile`, T.noWriteA, profileBody())).status).toBe(403);
  });

  it("replays an idempotent write and refuses a different body under the same key", async () => {
    const idem = key();
    const a = await send("put", `${base()}/profile`, T.ownerA, profileBody(), idem);
    const b = await send("put", `${base()}/profile`, T.ownerA, profileBody(), idem);
    expect(b.status).toBe(200);
    expect(b.body.version).toBe(a.body.version);
    expect((await send("put", `${base()}/profile`, T.ownerA, profileBody({ name_ar: "متجر آخر" }), idem)).status).toBe(422);
  });

  it("vacation pauses new orders, adjusts ETA and lapses by itself", async () => {
    const until = new Date(h.clock.ms + 5 * 86_400_000).toISOString();
    const r = await send("put", `${base()}/vacation`, T.ownerA, { enabled: true, until, eta_extra_days: 7 });
    expect(r.status).toBe(200);
    expect(r.body.vacation).toMatchObject({ enabled: true, eta_extra_days: 7 });
    expect((await get(`${base()}/storefront-preview`, T.ownerA)).body).toMatchObject({ accepting_orders: false, eta_extra_days: 7 });
    h.clock.ms += 6 * 86_400_000;
    expect((await get(`${base()}/storefront-preview`, T.ownerA)).body).toMatchObject({ accepting_orders: true, eta_extra_days: 0, on_vacation_until: null });
    expect((await send("put", `${base()}/vacation`, T.ownerA, { enabled: true, eta_extra_days: 1 })).body.code).toBe("vacation_until_required");
  });
});

describe("media uploads", () => {
  it("issues a store-bound signed URL, then confirms after scan and sets the logo", async () => {
    const up = await send("post", `${base()}/media/uploads`, T.ownerA, { slot: "logo", content_type: "image/png", byte_size: 50_000 });
    expect(up.status).toBe(201);
    expect(up.body.object_key).toMatch(new RegExp(`^stores/${STORE_A}/logo/`));
    expect(up.body.upload_url).toContain(up.body.object_key);
    const id = up.body.upload_id as string;
    expect((await send("post", `${base()}/media/uploads/${id}/confirm`, T.ownerA)).body.code).toBe("upload_missing_in_storage");
    h.scan.objects.set(up.body.object_key, { byteSize: 50_000, head: png(512, 512), malware: "pending" });
    expect((await send("post", `${base()}/media/uploads/${id}/confirm`, T.ownerA)).body.code).toBe("scan_pending");
    h.scan.objects.set(up.body.object_key, { byteSize: 50_000, head: png(512, 512), malware: "clean" });
    const ok = await send("post", `${base()}/media/uploads/${id}/confirm`, T.ownerA);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "confirmed", width: 512, height: 512 });
    expect((await get(`${base()}/profile`, T.ownerA)).body.logo_key).toBe(up.body.object_key);
    expect((await get(`${base()}/storefront-preview`, T.ownerA)).body.logo_url).toContain(up.body.object_key);
  });

  it("rejects disguised files, small images, infected files and a foreign store's upload id", async () => {
    const mk = async () => (await send("post", `${base()}/media/uploads`, T.ownerA, { slot: "logo", content_type: "image/png", byte_size: 1000 })).body;
    const exe = await mk();
    h.scan.objects.set(exe.object_key, { byteSize: 1000, head: Buffer.from("MZ\x90\x00 not an image"), malware: "clean" });
    expect((await send("post", `${base()}/media/uploads/${exe.upload_id}/confirm`, T.ownerA)).body.code).toBe("image_content_not_allowed");
    const small = await mk();
    h.scan.objects.set(small.object_key, { byteSize: 1000, head: png(64, 64), malware: "clean" });
    expect((await send("post", `${base()}/media/uploads/${small.upload_id}/confirm`, T.ownerA)).body.code).toBe("image_dimensions_too_small");
    const bad = await mk();
    h.scan.objects.set(bad.object_key, { byteSize: 1000, head: png(512, 512), malware: "infected" });
    expect((await send("post", `${base()}/media/uploads/${bad.upload_id}/confirm`, T.ownerA)).body.code).toBe("upload_infected");
    expect((await get(`${base()}/profile`, T.ownerA)).body.logo_key).toBeNull();
    // Store B cannot confirm store A's upload.
    expect((await send("post", `${base(STORE_B)}/media/uploads/${bad.upload_id}/confirm`, T.ownerB)).status).toBe(404);
    expect((await send("post", `${base()}/media/uploads`, T.ownerA, { slot: "logo", content_type: "image/gif", byte_size: 10 })).body.code).toBe("image_type_not_allowed");
    expect((await send("post", `${base()}/media/uploads`, T.ownerA, { slot: "logo", content_type: "image/png", byte_size: 9_000_000 })).body.code).toBe("image_too_large");
  });

  it("bulk product uploads: at most 20 per call, bound to the store prefix, catalog role allowed", async () => {
    const items = (n: number) => Array.from({ length: n }, () => ({ content_type: "image/jpeg", byte_size: 100_000 }));
    const ok = await send("post", `${base()}/media/product-uploads`, T.catalogA, { items: items(20) });
    expect(ok.status).toBe(201);
    expect(ok.body.items).toHaveLength(20);
    for (const i of ok.body.items) expect(i.object_key).toMatch(new RegExp(`^stores/${STORE_A}/product/`));
    expect((await send("post", `${base()}/media/product-uploads`, T.catalogA, { items: items(21) })).body.code).toBe("bulk_count_invalid");
    expect((await send("post", `${base()}/media/product-uploads`, T.supportA, { items: items(1) })).status).toBe(403);
    expect((await send("post", `${base(STORE_B)}/media/product-uploads`, T.catalogA, { items: items(1) })).status).toBe(404);
    expect((await send("post", `${base()}/media/product-uploads`, T.catalogA, { items: [{ content_type: "image/jpeg", byte_size: 100 }, { content_type: "text/html", byte_size: 5 }] })).status).toBe(422);
  });
});

describe("payout bank account", () => {
  const bankBody = (i = IBAN_1, name = "شركة النور للملابس") => ({ iban: i, account_holder_name: name });

  it("only owner and finance may change it; catalog, manager, warehouse and support may not", async () => {
    for (const t of [T.catalogA, T.managerA, T.warehouseA, T.supportA]) {
      expect((await send("put", `${base()}/payout-account`, t, bankBody())).status, t).toBe(403);
    }
    expect((await get(`${base()}/payout-account`, T.catalogA)).status).toBe(403);
    expect((await get(`${base()}/payout-account`, T.financeA)).body).toEqual({ configured: false });
    expect((await send("put", `${base(STORE_B)}/payout-account`, T.financeA, bankBody())).status).toBe(404);
  });

  it("sets the first account at once, never returns the full IBAN, and keeps an audit trail", async () => {
    const r = await send("put", `${base()}/payout-account`, T.financeA, bankBody(IBAN_1.replace(/(.{4})/g, "$1 ")));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: true, iban_last4: IBAN_1.slice(-4), payouts_held: false, name_match_score: 100 });
    expect(JSON.stringify(r.body)).not.toContain(IBAN_1);
    expect(JSON.stringify((await get(`${base()}/payout-account`, T.ownerA)).body)).not.toContain(IBAN_1.slice(0, 20));
    const hist = await get(`${base()}/payout-account/history`, T.ownerA);
    expect(hist.body.items[0].kind).toBe("payout_account.set");
    expect(JSON.stringify(hist.body)).not.toContain(IBAN_1);
    const rows = JSON.stringify(await h.repo.activeAccount(STORE_A));
    expect(rows).not.toContain(IBAN_1);
  });

  it("validates the IBAN checksum and the holder name against the legal name with an explainable score", async () => {
    const badIban = IBAN_1.slice(0, -1) + (IBAN_1.endsWith("0") ? "1" : "0");
    expect((await send("put", `${base()}/payout-account`, T.ownerA, bankBody(badIban))).body.code).toBe("invalid_iban");
    const mism = await send("put", `${base()}/payout-account`, T.ownerA, bankBody(IBAN_1, "محمد علي للتجارة"));
    expect(mism.status).toBe(422);
    expect(mism.body).toMatchObject({ code: "name_mismatch", required_score: ss.NAME_MATCH_MIN_SCORE });
    expect(typeof mism.body.score).toBe("number");
    expect(await h.repo.activeAccount(STORE_A)).toBeNull();
  });

  it("requires a recent strong factor", async () => {
    h.strong.stale.add(USERS.financeA);
    const r = await send("put", `${base()}/payout-account`, T.financeA, bankBody());
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("strong_factor_required");
    expect(await h.repo.activeAccount(STORE_A)).toBeNull();
  });

  it("replacing the account holds payouts to the new one for 48 hours (visible through the payouts port)", async () => {
    await send("put", `${base()}/payout-account`, T.financeA, bankBody(IBAN_1));
    const port = new SettingsPayoutAccountAdapter(h.repo, h.identity);
    expect((await port.activeAccount(STORE_A, h.clock.ms))?.holdUntilMs).toBeNull();
    expect((await send("put", `${base()}/payout-account`, T.financeA, bankBody(IBAN_1))).body.code).toBe("iban_unchanged");
    const r = await send("put", `${base()}/payout-account`, T.financeA, bankBody(IBAN_2));
    expect(r.body).toMatchObject({ payouts_held: true, iban_last4: IBAN_2.slice(-4) });
    const view = await port.activeAccount(STORE_A, h.clock.ms + 1000);
    expect(view).toMatchObject({ ibanLast4: IBAN_2.slice(-4), legalName: "شركة النور للملابس", holdUntilMs: h.clock.ms + ss.PAYOUT_ACCOUNT_COOLING_MS });
    expect((await port.activeAccount(STORE_A, h.clock.ms + ss.PAYOUT_ACCOUNT_COOLING_MS))?.holdUntilMs).toBeNull();
    expect((await get(`${base()}/payout-account/history`, T.financeA)).body.items.map((i: { kind: string }) => i.kind)).toContain("payout_account.replaced");
    expect(await port.activeAccount(STORE_B, h.clock.ms)).toBeNull();
  });
});

describe("shipping profile", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    origin: { governorate_code: "EG-C", city_code: "nasr-city", street: "10 Abbas El Akkad", landmark: "City Stars", contact_name: "Warehouse", contact_phone: "01012345678", pin: { lat: 30.05, lng: 31.3 } },
    handling_time_hours: 24,
    courier_preferences: { default: ["bosta", "aramex"], "EG-ALX": ["aramex"] },
    packaging_options: ["standard_box", "garment_bag"],
    ...over,
  });
  it("defaults to a 48h dispatch SLA, saves, and masks the contact phone", async () => {
    expect((await get(`${base()}/shipping`, T.ownerA)).body).toEqual({ configured: false, handling_time_hours: 48 });
    const r = await send("put", `${base()}/shipping`, T.managerA, body());
    expect(r.status).toBe(200);
    expect(r.body.origin.contact_phone_masked).toBe("+20********78");
    expect(JSON.stringify(r.body)).not.toContain("01012345678");
    expect(r.body).toMatchObject({ handling_time_hours: 24, courier_preferences: { default: ["bosta", "aramex"] } });
    expect((await get(`${base()}/storefront-preview`, T.ownerA)).body.handling_time_hours).toBe(24);
    expect((await get(`${base(STORE_B)}/shipping`, T.ownerA)).status).toBe(404);
  });
  it("validates handling time, couriers, area and pin", async () => {
    expect((await send("put", `${base()}/shipping`, T.ownerA, body({ handling_time_hours: 2 }))).body.code).toBe("handling_time_out_of_range");
    expect((await send("put", `${base()}/shipping`, T.ownerA, body({ courier_preferences: { default: ["fedex"] } }))).body.code).toBe("courier_unknown");
    expect((await send("put", `${base()}/shipping`, T.ownerA, body({ packaging_options: ["gold_bar"] }))).body.code).toBe("packaging_invalid");
    const o = body().origin;
    expect((await send("put", `${base()}/shipping`, T.ownerA, body({ origin: { ...o, pin: { lat: 10, lng: 10 } } }))).body.code).toBe("origin_pin_outside_egypt");
    expect((await send("put", `${base()}/shipping`, T.ownerA, body({ origin: { ...o, contact_phone: "123" } }))).body.code).toBe("origin_contact_invalid");
  });
});

describe("notification preferences", () => {
  it("lets optional channels change but transactional in_app can never be disabled", async () => {
    const r = await send("put", `${base()}/notification-preferences`, T.managerA, { preferences: { new_order: { sms: true, push: false }, marketing_tips: { in_app: false } } });
    expect(r.status).toBe(200);
    expect(r.body.preferences.new_order).toMatchObject({ sms: true, push: false, in_app: true });
    expect(r.body.transactional_events).toContain("payout_sent");
    for (const [ev, ch] of [["payout_sent", "in_app"], ["return_requested", "in_app"], ["account_security", "email"]] as const) {
      const bad = await send("put", `${base()}/notification-preferences`, T.ownerA, { preferences: { [ev]: { [ch]: false } } });
      expect(bad.status, ev).toBe(422);
      expect(bad.body.code).toBe("transactional_cannot_be_disabled");
    }
    expect((await send("put", `${base()}/notification-preferences`, T.ownerA, { preferences: { bogus: { sms: true } } })).status).toBe(400);
    expect((await get(`${base()}/notification-preferences`, T.ownerA)).body.preferences.new_order.sms).toBe(true);
    expect((await get(`${base(STORE_B)}/notification-preferences`, T.ownerA)).status).toBe(404);
  });
});

describe("team", () => {
  const invite = (t = T.ownerA, phone = "01012345678", role = "catalog") => send("post", `${base()}/team/invites`, t, { phone, role });

  it("lists members with masked phones; only the owner invites", async () => {
    const l = await get(`${base()}/team`, T.managerA);
    expect(l.body.members.map((m: { phone_masked: string }) => m.phone_masked)).toEqual(["+20********01", "+20********02"]);
    expect(JSON.stringify(l.body)).not.toContain("+201000000001");
    for (const t of [T.managerA, T.catalogA, T.financeA]) expect((await invite(t)).status, t).toBe(403);
    expect((await get(`${base()}/team`, T.catalogA)).status).toBe(403);
  });

  it("invite, accept with the hashed single-use token, grant created, replay refused", async () => {
    const r = await invite();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ role: "catalog", status: "PENDING", phone_masked: "+20********78" });
    expect(JSON.stringify(r.body)).not.toMatch(/token/);
    const sent = h.delivery.sent[0];
    expect(sent?.phoneE164).toBe("+201012345678");
    const token = sent?.token ?? "";
    const stored = JSON.stringify(await h.repo.listInvites(STORE_A));
    expect(stored).not.toContain(token);
    // Someone else's phone: indistinguishable from an unknown token.
    expect((await send("post", "/v1/seller/team-invites/accept", T.stranger, { token })).status).toBe(404);
    expect((await send("post", "/v1/seller/team-invites/accept", T.invitee, { token: "0".repeat(64) })).status).toBe(404);
    const ok = await send("post", "/v1/seller/team-invites/accept", T.invitee, { token });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ store_id: STORE_A, role: "catalog" });
    expect((await h.members.listMembers(STORE_A)).some((m) => m.userId === USERS.invitee && m.role === "catalog")).toBe(true);
    const replay = await send("post", "/v1/seller/team-invites/accept", T.invitee, { token });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("invite_not_pending");
  });

  it("refuses expired tokens after 72h, supports decline and revoke, and blocks duplicates", async () => {
    await invite();
    expect((await invite()).body.code).toBe("duplicate_pending_invite");
    const token = h.delivery.sent[0]?.token ?? "";
    h.clock.ms += ss.INVITE_TTL_MS + 1;
    const late = await send("post", "/v1/seller/team-invites/accept", T.invitee, { token });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("invite_expired");
    const second = await invite(T.ownerA, "01012345678");
    expect(second.status).toBe(201);
    const t2 = h.delivery.sent[1]?.token ?? "";
    expect((await send("post", "/v1/seller/team-invites/decline", T.invitee, { token: t2 })).status).toBe(204);
    expect((await send("post", "/v1/seller/team-invites/accept", T.invitee, { token: t2 })).status).toBe(409);
    const third = await invite(T.ownerA, "01012345678");
    const rev = await send("delete", `${base()}/team/invites/${third.body.id}`, T.ownerA);
    expect(rev.status).toBe(204);
    expect((await send("delete", `${base()}/team/invites/${third.body.id}`, T.ownerA)).status).toBe(409);
    expect((await send("delete", `${base(STORE_B)}/team/invites/${third.body.id}`, T.ownerB)).status).toBe(404);
    expect((await invite(T.ownerA, "01000000001")).body.code).toBe("already_member");
    expect((await invite(T.ownerA, "12345")).body.code).toBe("phone_invalid");
  });

  it("changes roles owner-only and never demotes or removes the last owner", async () => {
    expect((await send("patch", `${base()}/team/members/${USERS.managerA}`, T.managerA, { role: "owner" })).status).toBe(403);
    const ok = await send("patch", `${base()}/team/members/${USERS.managerA}`, T.ownerA, { role: "finance" });
    expect(ok.status).toBe(200);
    expect((await h.members.listMembers(STORE_A)).find((m) => m.userId === USERS.managerA)?.role).toBe("finance");
    expect((await send("patch", `${base()}/team/members/${USERS.ownerA}`, T.ownerA, { role: "manager" })).body.code).toBe("last_owner");
    expect((await send("delete", `${base()}/team/members/${USERS.ownerA}`, T.ownerA)).body.code).toBe("last_owner");
    expect((await send("delete", `${base()}/team/members/${U(999)}`, T.ownerA)).status).toBe(404);
    expect((await send("delete", `${base()}/team/members/${USERS.managerA}`, T.managerA)).status).toBe(403);
    expect((await send("delete", `${base()}/team/members/${USERS.managerA}`, T.ownerA)).status).toBe(204);
    expect((await send("patch", `${base(STORE_B)}/team/members/${USERS.ownerA}`, T.ownerA, { role: "manager" })).status).toBe(404);
  });
});

describe("ETA enrolment status", () => {
  it("records status and timestamps only", async () => {
    expect((await get(`${base()}/eta-enrolment`, T.ownerA)).body.status).toBe("not_enrolled");
    const pending = await send("post", `${base()}/eta-enrolment/request`, T.ownerA);
    expect(pending.body).toMatchObject({ status: "pending_verification", last_verified_at: null });
    expect(Object.keys(pending.body).sort()).toEqual(["failure_code", "last_checked_at", "last_verified_at", "requested_at", "status"]);
    expect((await send("post", `${base()}/eta-enrolment/request`, T.ownerA)).body.code).toBe("eta_invalid_transition");
    expect((await send("post", `${base()}/eta-enrolment/revoke`, T.ownerA)).body.status).toBe("revoked");
    h.eta.result = "verified";
    const v = await send("post", `${base()}/eta-enrolment/request`, T.ownerA);
    expect(v.body.status).toBe("verified");
    expect(v.body.last_verified_at).not.toBeNull();
  });
});
