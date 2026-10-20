import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIdGenerator, nodeCsprng, systemClock } from "../../platform/system-adapters";
import { unconfigured } from "../../production/unconfigured";
import { createHarness, login, type Harness, type LoggedIn } from "../../test/harness";
import type { FieldCipher } from "../auth";
import { AddressBookCheckoutPort } from "./checkout-port";
import { InMemoryAddressStore } from "./in-memory";
import { createAddressService } from "./addresses.module";
import { ADDRESS_SERVICE } from "./tokens";
import type { AddressService } from "./service";

let h: Harness;
let a: LoggedIn;
let b: LoggedIn;
let c: LoggedIn;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
let n = 0;
const key = (): string => `0192f3a4-5b6c-7d8e-9f01-${String(++n + 1000).padStart(12, "0")}`;
const body = (over: Record<string, unknown> = {}) => ({
  recipient_name: "Nada Khalifa",
  phone_e164: "+201001234567",
  governorate_code: "EG-C",
  city_district_code: "maadi",
  street: "Road 9",
  building: "4",
  landmark: "Opposite the metro",
  map_pin: { lat: 30.04, lng: 31.23 },
  ...over,
});
const post = (t: string, o: Record<string, unknown> = {}, k = key()) => h.http().post("/v1/me/addresses").set(bearer(t)).set("Idempotency-Key", k).send(body(o));

beforeAll(async () => {
  h = await createHarness();
  a = await login(h, "+201001250001");
  b = await login(h, "+201001250002");
  c = await login(h, "+201001250003");
}, 60_000);
afterAll(async () => {
  await h.close();
});

describe("addresses over HTTP", () => {
  it("401 without a token on every route", async () => {
    for (const [m, p] of [["get", "/v1/me/addresses"], ["post", "/v1/me/addresses"], ["get", "/v1/me/addresses/x"], ["patch", "/v1/me/addresses/x"], ["delete", "/v1/me/addresses/x"], ["post", "/v1/me/addresses/x/default"], ["get", "/v1/coverage/governorates"], ["get", "/v1/coverage/cities?governorate=EG-C"]] as const) {
      expect((await h.http()[m](p)).status, `${m} ${p}`).toBe(401);
    }
  });

  it("empty list is 200, not 404, and is no-store", async () => {
    const r = await h.http().get("/v1/me/addresses").set(bearer(c.accessToken));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], page: { next_cursor: null, has_more: false } });
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("creates (201), first is default, derives COD eligibility and quality, normalizes the phone", async () => {
    const r = await post(a.accessToken);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ is_default: true, cod_eligible: true, quality_score: 90, phone_e164: "+201001234567", courier_coverage: "covered", governorate_code: "EG-C" });
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("requires an Idempotency-Key; a replay returns the same address, a changed body is 422", async () => {
    expect((await h.http().post("/v1/me/addresses").set(bearer(a.accessToken)).send(body({ building: "70" }))).status).toBe(400);
    const k = key();
    const r1 = await post(a.accessToken, { building: "71" }, k);
    const r2 = await post(a.accessToken, { building: "71" }, k);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.id).toBe(r1.body.id);
    expect((await post(a.accessToken, { building: "72" }, k)).status).toBe(422);
    const list = await h.http().get("/v1/me/addresses").set(bearer(a.accessToken));
    expect(list.body.items.filter((i: { building: string }) => i.building === "71")).toHaveLength(1);
  });

  it("400 Problem+JSON for malformed bodies and semantic errors with pointers", async () => {
    const r = await post(a.accessToken, { phone_e164: "+201301234567", city_district_code: "atlantis" });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "validation_failed" });
    expect(r.body.errors).toEqual(expect.arrayContaining([{ pointer: "/body/phone_e164", code: "invalid_eg_phone" }, { pointer: "/body/city_district_code", code: "unknown_city" }]));
    expect((await post(a.accessToken, { extra: "x" })).status).toBe(400);
    expect((await post(a.accessToken, { map_pin: { lat: 51, lng: 0 } })).body.errors).toEqual([{ pointer: "/body/map_pin", code: "outside_egypt" }]);
  });

  it("owner-only: another user's address is 404 on GET, PATCH, DELETE and default; nothing leaks", async () => {
    const mine = await post(a.accessToken, { building: "80" });
    const id = mine.body.id as string;
    expect((await h.http().get(`/v1/me/addresses/${id}`).set(bearer(b.accessToken))).status).toBe(404);
    expect((await h.http().patch(`/v1/me/addresses/${id}`).set(bearer(b.accessToken)).set("Idempotency-Key", key()).send({ street: "Hacked" })).status).toBe(404);
    expect((await h.http().post(`/v1/me/addresses/${id}/default`).set(bearer(b.accessToken)).set("Idempotency-Key", key())).status).toBe(404);
    expect((await h.http().delete(`/v1/me/addresses/${id}`).set(bearer(b.accessToken)).set("Idempotency-Key", key())).status).toBe(404);
    expect((await h.http().get("/v1/me/addresses/not-a-uuid").set(bearer(a.accessToken))).status).toBe(404);
    const lb = await h.http().get("/v1/me/addresses").set(bearer(b.accessToken));
    expect(JSON.stringify(lb.body)).not.toContain(id);
    expect((await h.http().get(`/v1/me/addresses/${id}`).set(bearer(a.accessToken))).body.street).toBe("Road 9");
  });

  it("PATCH updates and clears; default and delete rules hold; max 10 returns 409", async () => {
    const u = b;
    const first = await post(u.accessToken, { building: "1" });
    const second = await post(u.accessToken, { building: "2" });
    expect([first.body.is_default, second.body.is_default]).toEqual([true, false]);
    const patched = await h.http().patch(`/v1/me/addresses/${second.body.id}`).set(bearer(u.accessToken)).set("Idempotency-Key", key()).send({ landmark: null });
    expect(patched.status).toBe(200);
    expect(patched.body.cod_eligible).toBe(false);
    expect(patched.body.landmark).toBeUndefined();
    expect((await h.http().patch(`/v1/me/addresses/${second.body.id}`).set(bearer(u.accessToken)).set("Idempotency-Key", key()).send({})).status).toBe(400);
    const dflt = await h.http().post(`/v1/me/addresses/${second.body.id}/default`).set(bearer(u.accessToken)).set("Idempotency-Key", key());
    expect(dflt.body.is_default).toBe(true);
    expect((await h.http().get(`/v1/me/addresses/${first.body.id}`).set(bearer(u.accessToken))).body.is_default).toBe(false);
    expect((await h.http().delete(`/v1/me/addresses/${second.body.id}`).set(bearer(u.accessToken)).set("Idempotency-Key", key())).status).toBe(204);
    expect((await h.http().get(`/v1/me/addresses/${first.body.id}`).set(bearer(u.accessToken))).body.is_default).toBe(true);
    for (let i = 3; i <= 5; i += 1) expect((await post(u.accessToken, { building: String(i) })).status).toBe(201);
    const dup = await post(u.accessToken, { building: "3" });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("address_duplicate");
    for (let i = 6; i <= 11; i += 1) expect((await post(u.accessToken, { building: String(i) })).status).toBe(201);
    const over = await post(u.accessToken, { building: "99" });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("address_limit_reached");
  });

  it("keyset pagination", async () => {
    const p1 = await h.http().get("/v1/me/addresses?limit=4").set(bearer(b.accessToken));
    expect(p1.body.items).toHaveLength(4);
    expect(p1.body.page.has_more).toBe(true);
    const p2 = await h.http().get(`/v1/me/addresses?limit=4&cursor=${p1.body.page.next_cursor as string}`).set(bearer(b.accessToken));
    const ids = [...p1.body.items, ...p2.body.items].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await h.http().get("/v1/me/addresses?cursor=%25%25").set(bearer(b.accessToken))).status).toBe(400);
    expect((await h.http().get("/v1/me/addresses?limit=500").set(bearer(b.accessToken))).status).toBe(400);
  });

  it("coverage endpoints list 27 governorates and their cities in Arabic and English", async () => {
    const g = await h.http().get("/v1/coverage/governorates").set(bearer(a.accessToken));
    expect(g.status).toBe(200);
    expect(g.body.items).toHaveLength(27);
    expect(g.body.items[0]).toEqual({ code: "EG-C", name_ar: "القاهرة", name_en: "Cairo", courier_coverage: "covered" });
    const ci = await h.http().get("/v1/coverage/cities?governorate=EG-GZ").set(bearer(a.accessToken));
    expect(ci.body.items.map((x: { code: string }) => x.code)).toContain("dokki");
    expect((await h.http().get("/v1/coverage/cities?governorate=EG-ZZ").set(bearer(a.accessToken))).status).toBe(404);
    expect((await h.http().get("/v1/coverage/cities").set(bearer(a.accessToken))).status).toBe(400);
  });
});

describe("KMS not configured", () => {
  let hk: Harness;
  let u: LoggedIn;
  beforeAll(async () => {
    const svc = createAddressService(new InMemoryAddressStore(), unconfigured<FieldCipher>("kms.envelope"), systemClock, createIdGenerator(systemClock, nodeCsprng));
    hk = await createHarness({ customise: (t) => t.overrideProvider(ADDRESS_SERVICE).useValue(svc) });
    u = await login(hk, "+201001250009");
  }, 60_000);
  afterAll(async () => {
    await hk.close();
  });
  it("save is 503 provider_not_configured; empty list and coverage still work", async () => {
    const r = await hk.http().post("/v1/me/addresses").set(bearer(u.accessToken)).set("Idempotency-Key", key()).send(body());
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("provider_not_configured");
    expect((await hk.http().get("/v1/me/addresses").set(bearer(u.accessToken))).status).toBe(200);
    expect((await hk.http().get("/v1/coverage/governorates").set(bearer(u.accessToken))).body.items).toHaveLength(27);
  });
});

describe("checkout AddressPort", () => {
  it("resolves a saved address to first name and governorate; not_found for strangers; not_covered; gift tokens give coverage only", async () => {
    const svc = h.app.get<AddressService>(ADDRESS_SERVICE);
    const port = new AddressBookCheckoutPort(svc);
    const mine = await post(c.accessToken, { building: "20" });
    const id = mine.body.id as string;
    expect(await port.resolve(c.userId, id)).toEqual({ kind: "ok", contact: { firstName: "Nada", phoneRelay: null, governorateCode: "EG-C" } });
    expect(await port.resolve(a.userId, id)).toEqual({ kind: "not_found" });
    expect(await port.resolve(c.userId, "nope")).toEqual({ kind: "not_found" });
    const far = await post(c.accessToken, { building: "21", governorate_code: "EG-WAD", city_district_code: "kharga" });
    expect(await port.resolve(c.userId, far.body.id as string)).toEqual({ kind: "not_covered" });
    const tok = await svc.issueGiftToken(c.userId, id, 3_600_000);
    expect(await port.resolve(a.userId, tok?.token ?? "")).toEqual({ kind: "ok", contact: { firstName: null, phoneRelay: null, governorateCode: "EG-C" } });
    expect(randomBytes(1).length).toBe(1);
  });
});
