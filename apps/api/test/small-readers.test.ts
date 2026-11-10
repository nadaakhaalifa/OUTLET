import { describe, expect, it } from "vitest";
import { GeoReader } from "../src/modules/addresses/geo-reader.js";
import { toPackageInput, toWire } from "../src/modules/addresses/wire.js";
import type { GeoArea, GeoPort } from "../src/modules/addresses/services.js";
import { maskPhone, pgPhoneLabel } from "../src/modules/auth/user-label.js";
import { denyAllWebhookIps, staticWebhookIps, unconfiguredCodConfirmation } from "../src/modules/checkout/ports.js";
import { PgOnboardingLookup } from "../src/modules/seller-onboarding/lookup.js";
import { PgPaymentKind } from "../src/modules/seller-orders/pg-payment-kind.js";
import { M1, S1, U1, fakeClient } from "./fake-sql.js";

describe("maskPhone / pgPhoneLabel", () => {
  it("masks long numbers and gives a generic label to short ones", () => {
    expect(maskPhone("+201001234567")).toBe("+20********67");
    expect(maskPhone("+2012")).toBe("Outlex account");
  });
  const cipher = { decrypt: (ct: Uint8Array, aad: string) => Promise.resolve(`${aad}:${String(ct.length)}`.padEnd(12, "0")) } as never;
  it("returns the generic label when there is no row or a null ciphertext", async () => {
    expect(await pgPhoneLabel(fakeClient(() => []).client, M1, cipher)(U1)).toBe("Outlex account");
    expect(await pgPhoneLabel(fakeClient((s) => (s.includes("phone_ct") ? [{ phone_ct: null }] : [])).client, M1, cipher)(U1)).toBe("Outlex account");
  });
  it("decrypts under the users.phone_ct purpose and masks the result", async () => {
    const seen: string[] = [];
    const c = { decrypt: (_: Uint8Array, aad: string) => { seen.push(aad); return Promise.resolve("+201001234567"); } } as never;
    const label = await pgPhoneLabel(fakeClient((s) => (s.includes("phone_ct") ? [{ phone_ct: new Uint8Array([1]) }] : [])).client, M1, c)(U1);
    expect(label).toBe("+20********67");
    expect(seen).toEqual(["users.phone_ct"]);
  });
});

describe("PgPaymentKind", () => {
  const kind = (rows: object[]) => new PgPaymentKind(fakeClient((s) => (s.includes("order_groups") ? rows : [])).client, M1).kindOf({ userId: U1, orderGroupId: S1 });
  it("null when the group is not visible, cod vs prepaid otherwise", async () => {
    expect(await kind([])).toBeNull();
    expect(await kind([{ payment_method: "cod" }])).toBe("cod");
    expect(await kind([{ payment_method: "card" }])).toBe("prepaid");
  });
});

describe("PgOnboardingLookup", () => {
  const mk = (rows: object[]) => new PgOnboardingLookup(fakeClient((s) => (s.includes("FROM kyc_cases") || s.includes("store_members") ? rows : [])).client, M1);
  it("sellerOf: id or null", async () => {
    expect(await mk([{ seller_id: S1 }]).sellerOf(U1)).toBe(S1);
    expect(await mk([]).sellerOf(U1)).toBeNull();
  });
  it("inviteExpiry: null for no row or null column, a Date otherwise", async () => {
    expect(await mk([]).inviteExpiry(S1, U1)).toBeNull();
    expect(await mk([{ invite_expires_at: null }]).inviteExpiry(S1, U1)).toBeNull();
    expect((await mk([{ invite_expires_at: "2026-01-01T00:00:00Z" }]).inviteExpiry(S1, U1))?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("webhook and COD ports fail closed", () => {
  it("deny-all and static policies", async () => {
    expect(denyAllWebhookIps.allowed("paymob", "1.1.1.1")).toBe(false);
    const p = staticWebhookIps({ paymob: ["1.1.1.1"] });
    expect(p.allowed("paymob", "1.1.1.1")).toBe(true);
    expect(p.allowed("paymob", "2.2.2.2")).toBe(false);
    expect(p.allowed("fawry", "1.1.1.1")).toBe(false);
    expect(p.allowed("toString", "x")).toBe(false);
    expect(await unconfiguredCodConfirmation.verify({ userId: U1, orderGroupId: S1, code: "123456" })).toBe(false);
  });
});

describe("GeoReader", () => {
  const rowsFor = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id${String(i)}`, parent_id: null, level: "governorate", code: `c${String(i)}`, name_ar: "ع", name_en: null, shipping_zone_code: null }));
  it("pages with a cursor and omits it on the last page", async () => {
    const g = new GeoReader(fakeClient((s) => (s.includes("FROM geo_areas") ? rowsFor(3) : [])).client, M1);
    const p1 = await g.list({ limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const g2 = new GeoReader(fakeClient((s) => (s.includes("FROM geo_areas") ? rowsFor(2) : [])).client, M1);
    expect((await g2.list({ limit: 2 })).nextCursor).toBeNull();
    expect((await g2.list({ limit: 2 })).items[0]?.nameEn).toBeNull();
  });
  it("passes filters and a decoded cursor as parameters", async () => {
    const { client, log } = fakeClient(() => []);
    const g = new GeoReader(client, M1);
    const cur = Buffer.from("c1|id1").toString("base64url");
    await g.list({ limit: 5, parentId: S1, level: "city", cursor: cur });
    const p = log.stmts.find((x) => x.sql.includes("geo_areas"))?.params;
    expect(p).toEqual([M1, S1, "city", "c1", "id1", 6]);
    await expect(g.list({ limit: 5, cursor: "!!" })).rejects.toMatchObject({ status: 400 });
  });
  it("stamps is empty without ids and maps dates otherwise", async () => {
    const g = new GeoReader(fakeClient((s) => (s.includes("FROM addresses") ? [{ id: "a", created_at: "2026-01-01T00:00:00Z", validated_at: null }, { id: "b", created_at: "2026-01-01T00:00:00Z", validated_at: "2026-01-02T00:00:00Z" }] : [])).client, M1);
    expect((await g.stamps(U1, [])).size).toBe(0);
    const m = await g.stamps(U1, ["a", "b"]);
    expect(m.get("a")?.validatedAt).toBeNull();
    expect(m.get("b")?.validatedAt?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });
  it("byIds / byCodes map rows", async () => {
    const g = new GeoReader(fakeClient((s) => (s.includes("FROM geo_areas") ? [{ id: "i", parent_id: "p", level: "city", code: "c" }] : [])).client, M1);
    expect(await g.byIds(["i"])).toEqual([{ id: "i", parentId: "p", level: "city", code: "c" }]);
    expect(await g.byCodes(["c"])).toHaveLength(1);
  });
});

const area = (id: string, level: string, code: string, parentId: string | null): GeoArea => ({ id, level, code, parentId });
const geoOf = (all: GeoArea[]): GeoPort => ({
  list: () => Promise.resolve({ items: [], nextCursor: null }),
  byIds: (ids) => Promise.resolve(all.filter((a) => ids.includes(a.id))),
  byCodes: (codes) => Promise.resolve(all.filter((a) => codes.includes(a.code))),
  stamps: () => Promise.resolve(new Map()),
});
const GOV = area("g", "governorate", "CAI", null);
const CITY = area("c", "city", "CAI-C", "g");
const DIST = area("d", "district", "CAI-C-D", "c");
const body = (district: string, extra: object = {}) => ({ recipient_name: "n", phone_e164: "+201001234567", fields: { governorate_id: "g", district_id: district, street: "s", building: "b", landmark: "l", ...extra } }) as never;

describe("address wire", () => {
  it("city leaf, district leaf, optional pieces", async () => {
    const geo = geoOf([GOV, CITY, DIST]);
    const a = await toPackageInput(geo, body("c"));
    expect(a.address).toMatchObject({ governorateCode: "CAI", cityCode: "CAI-C" });
    expect("districtCode" in a.address).toBe(false);
    const b = await toPackageInput(geo, { ...(body("d", { floor: "2", apartment: "5" }) as object), label: "home", is_default: true, pin: { lat_e7: 300000000, lng_e7: 310000000 } } as never);
    expect(b).toMatchObject({ label: "home", isDefault: true, address: { districtCode: "CAI-C-D", floor: "2", apartment: "5", pin: { lat: 30, lng: 31 } } });
  });
  it("422 for unknown, wrong-level, mismatched-parent and orphan areas", async () => {
    await expect(toPackageInput(geoOf([CITY]), body("c"))).rejects.toMatchObject({ status: 422 });
    await expect(toPackageInput(geoOf([GOV]), body("zzz"))).rejects.toMatchObject({ status: 422 });
    await expect(toPackageInput(geoOf([GOV, area("c", "city", "X", "other")]), body("c"))).rejects.toMatchObject({ status: 422 });
    await expect(toPackageInput(geoOf([GOV, DIST]), body("d"))).rejects.toMatchObject({ status: 422 });
    await expect(toPackageInput(geoOf([GOV, area("c", "city", "X", "other"), area("d", "district", "Y", "c")]), body("d"))).rejects.toMatchObject({ status: 422 });
    await expect(toPackageInput(geoOf([GOV, area("d", "district", "Y", null)]), body("d"))).rejects.toMatchObject({ status: 422 });
    await expect(toPackageInput(geoOf([GOV, area("d", "zone", "Z", "g")]), body("d"))).rejects.toMatchObject({ status: 422 });
  });
  it("toWire with and without stamps / pin / optional fields", async () => {
    const view = { id: "a1", label: "home", recipientName: "n", phone: "+20100", isDefault: false, codEligible: true, address: { governorateCode: "CAI", cityCode: "CAI-C", street: "s", building: "b", landmark: undefined } };
    const geo = { ...geoOf([GOV, CITY, DIST]), stamps: () => Promise.resolve(new Map([["a1", { createdAt: new Date("2026-01-01T00:00:00Z"), validatedAt: new Date("2026-01-02T00:00:00Z") }]])) };
    const [w] = await toWire(geo, U1, [view]);
    expect(w).toMatchObject({ geo_area_id: "c", pin: null, validated_at: "2026-01-02T00:00:00.000Z", fields: { floor: null, apartment: null, landmark: "" } });
    const [w2] = await toWire(geoOf([GOV]), U1, [{ ...view, address: { ...view.address, districtCode: "CAI-C-D", floor: "3", pin: { lat: 30.5, lng: 31.25 } } }]);
    expect(w2).toMatchObject({ geo_area_id: "", validated_at: null, created_at: new Date(0).toISOString(), pin: { lat_e7: 305000000, lng_e7: 312500000 }, fields: { floor: "3", governorate_id: "g" } });
  });
});
