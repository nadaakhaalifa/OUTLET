import type { Test } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FLAG_HOME_BANNERS } from "../domain/ports";
import { NOW_MS, TOKENS, U, bearer, createBannerHarness, idemKey, type BannerHarness } from "./harness";

let h: BannerHarness;
const ADMIN = "/v1/admin/home-banners";
const SHOPPER = "/v1/home/banners";
const H = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

beforeAll(async () => {
  h = await createBannerHarness();
}, 30_000);
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.flags.set(FLAG_HOME_BANNERS, true);
  h.audit.failNext = false;
  h.audit.entries.length = 0;
});

const post = (token: string, path: string, body: unknown = {}) => h.http().post(path).set({ ...bearer(token), ...idemKey() }).send(body as object);
const body = (o: Record<string, unknown> = {}) => ({
  title: { ar: "خصم نهاية الموسم", en: "End of season" },
  starts_at: iso(NOW_MS - H),
  ends_at: iso(NOW_MS + H),
  cta: { kind: "search", query: "linen dress", price_max: 150_000 },
  ...o,
});
async function live(o: Record<string, unknown> = {}): Promise<string> {
  const c = await post(TOKENS.marketing, ADMIN, body(o));
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const s = await post(TOKENS.marketing, `${ADMIN}/${c.body.id as string}/schedule`);
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return c.body.id as string;
}

describe("admin lifecycle", () => {
  it("creates a draft, schedules, shows to shoppers with the public shape, pauses, resumes and deletes", async () => {
    const c = await post(TOKENS.marketing, ADMIN, body({ art_variant: "festive", priority: 500 }));
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ status: "draft", lifecycle: "draft", version: 1, sponsored: false, sponsor_label: null });
    const id = c.body.id as string;
    expect((await h.http().get(SHOPPER).set(bearer(TOKENS.shopper))).body.items).toEqual([]);

    expect((await post(TOKENS.ops, `${ADMIN}/${id}/schedule`)).body).toMatchObject({ status: "scheduled", lifecycle: "live" });
    const r = await h.http().get(SHOPPER).set(bearer(TOKENS.shopper));
    expect(r.status).toBe(200);
    expect(r.body.server_time).toBe(iso(NOW_MS));
    expect(r.body.items).toEqual([
      {
        id,
        title: { ar: "خصم نهاية الموسم", en: "End of season" },
        art_variant: "festive",
        sponsored: false,
        starts_at: iso(NOW_MS - H),
        ends_at: iso(NOW_MS + H),
        cta: { kind: "search", query: "linen dress", price_max: 150_000 },
      },
    ]);
    expect(r.headers["cache-control"]).toBe("private, max-age=30");
    expect(r.headers.etag).toBeTruthy();
    const again = await h.http().get(SHOPPER).set({ ...bearer(TOKENS.shopper), "If-None-Match": r.headers.etag as string });
    expect(again.status).toBe(304);

    expect((await post(TOKENS.marketing, `${ADMIN}/${id}/pause`)).body).toMatchObject({ status: "paused", lifecycle: "paused" });
    expect((await h.http().get(SHOPPER).set(bearer(TOKENS.shopper))).body.items).toEqual([]);
    expect((await post(TOKENS.marketing, `${ADMIN}/${id}/pause`)).status).toBe(409);
    expect((await post(TOKENS.marketing, `${ADMIN}/${id}/resume`)).body.status).toBe("scheduled");

    const del = await h.http().delete(`${ADMIN}/${id}`).set({ ...bearer(TOKENS.marketing), ...idemKey() });
    expect(del.status).toBe(204);
    expect((await h.http().get(`${ADMIN}/${id}`).set(bearer(TOKENS.marketing))).status).toBe(404);
    expect(h.audit.entries.map((e) => e.action)).toEqual([
      "home_banner.create",
      "home_banner.schedule",
      "home_banner.pause",
      "home_banner.resume",
      "home_banner.delete",
    ]);
  });

  it("decides visibility by server time, not the request", async () => {
    const id = await live({ starts_at: iso(NOW_MS + H), ends_at: iso(NOW_MS + 2 * H) });
    const get = () => h.http().get(`${SHOPPER}?now=${iso(NOW_MS + 90 * 60_000)}`).set({ ...bearer(TOKENS.shopper), Date: iso(NOW_MS + 90 * 60_000) });
    expect((await get()).body.items).toEqual([]);
    h.clock.advance(H + 1);
    expect((await get()).body.items.map((i: { id: string }) => i.id)).toEqual([id]);
    h.clock.advance(2 * H);
    expect((await get()).body.items).toEqual([]);
    h.clock.advance(-3 * H - 1);
  });

  it("edits with If-Match, refuses stale versions and keeps a sponsored banner labelled and referenced", async () => {
    const c = await post(TOKENS.marketing, ADMIN, body({ sponsored: true, sponsor_ref: "ads:campaign-77" }));
    expect(c.body).toMatchObject({ sponsored: true, sponsor_ref: "ads:campaign-77", sponsor_label: { ar: "إعلان", en: "Sponsored" } });
    const id = c.body.id as string;
    const ok = await h.http().patch(`${ADMIN}/${id}`).set({ ...bearer(TOKENS.marketing), ...idemKey(), "If-Match": '"v1"' }).send({ priority: 700 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ priority: 700, version: 2 });
    const stale = await h.http().patch(`${ADMIN}/${id}`).set({ ...bearer(TOKENS.marketing), ...idemKey(), "If-Match": '"v1"' }).send({ priority: 1 });
    expect(stale.status).toBe(412);
    const none = await h.http().patch(`${ADMIN}/${id}`).set({ ...bearer(TOKENS.marketing), ...idemKey() }).send({ priority: 2 });
    expect(none.status).toBe(428);
    const drop = await h.http().patch(`${ADMIN}/${id}`).set({ ...bearer(TOKENS.marketing), ...idemKey(), "If-Match": '"v2"' }).send({ sponsor_ref: null });
    expect(drop.status).toBe(400);
    await post(TOKENS.marketing, `${ADMIN}/${id}/schedule`);
    const pub = await h.http().get(SHOPPER).set(bearer(TOKENS.shopper));
    const item = pub.body.items.find((i: { id: string }) => i.id === id);
    expect(item.sponsored).toBe(true);
    expect(JSON.stringify(pub.body)).not.toContain("ads:campaign-77");
    expect(Object.keys(item).sort()).toEqual(["cta", "ends_at", "id", "sponsored", "starts_at", "title"]);
  });

  it("composes at most 8 slides and spaces sponsored ones; preview uses the same composer", async () => {
    for (let i = 0; i < 6; i++) await live({ title: { ar: `عرض ${i}` }, priority: 400 - i });
    for (let i = 0; i < 4; i++) await live({ title: { ar: `إعلان ${i}` }, priority: 900 - i, sponsored: true, sponsor_ref: `ads:camp-${i}000` });
    const r = await h.http().get(SHOPPER).set(bearer(TOKENS.shopper));
    expect(r.body.items.length).toBeLessThanOrEqual(8);
    const flags: boolean[] = r.body.items.map((i: { sponsored: boolean }) => i.sponsored);
    for (let i = 0; i < flags.length; i++) expect(flags.slice(i, i + 3).filter(Boolean).length).toBeLessThanOrEqual(1);
    const p = await h.http().get(`${ADMIN}/preview`).set(bearer(TOKENS.marketing));
    expect(p.status).toBe(200);
    expect(p.body.items.map((i: { id: string }) => i.id)).toEqual(r.body.items.map((i: { id: string }) => i.id));
    const later = await h.http().get(`${ADMIN}/preview?at=${encodeURIComponent(iso(NOW_MS + 5 * H))}`).set(bearer(TOKENS.marketing));
    expect(later.body.items).toEqual([]);
  });
});

describe("validation", () => {
  it("refuses free-form URLs, bad windows, missing Arabic and unknown fields", async () => {
    const bad = async (o: Record<string, unknown>) => (await post(TOKENS.marketing, ADMIN, body(o))).status;
    expect(await bad({ cta: { kind: "url", target_id: "https://evil.example" } })).toBe(400);
    expect(await bad({ cta: { kind: "store", target_id: "https://evil.example" } })).toBe(400);
    expect(await bad({ cta: { kind: "search", query: "https://evil.example" } })).toBe(400);
    expect(await bad({ cta: { kind: "search", query: "x", price_min: 5, price_max: 1 } })).toBe(400);
    expect(await bad({ cta: { kind: "drop", target_id: "d1", price_min: 1 } })).toBe(400);
    expect(await bad({ image_key: "https://cdn.example/a.png" })).toBe(400);
    expect(await bad({ starts_at: iso(NOW_MS + H), ends_at: iso(NOW_MS) })).toBe(400);
    expect(await bad({ title: { en: "only english" } })).toBe(400);
    expect(await bad({ sponsored: true })).toBe(400);
    expect(await bad({ image_url: "https://cdn.example/a.png" })).toBe(400);
    expect(await bad({ segment: "high_budget" })).toBe(400);
  });
  it("refuses to schedule or resume a banner whose window has ended", async () => {
    const c = await post(TOKENS.marketing, ADMIN, body({ starts_at: iso(NOW_MS - 2 * H), ends_at: iso(NOW_MS - H) }));
    const s = await post(TOKENS.marketing, `${ADMIN}/${c.body.id as string}/schedule`);
    expect(s.status).toBe(409);
    expect(s.body.code).toBe("window_elapsed");
  });
});

describe("authorization", () => {
  const routes: Array<[string, string, unknown?]> = [
    ["get", ADMIN],
    ["get", `${ADMIN}/preview`],
    ["get", `${ADMIN}/${U(5)}`],
    ["post", ADMIN, body()],
    ["patch", `${ADMIN}/${U(5)}`, { priority: 1 }],
    ["post", `${ADMIN}/${U(5)}/schedule`],
    ["post", `${ADMIN}/${U(5)}/pause`],
    ["post", `${ADMIN}/${U(5)}/resume`],
    ["delete", `${ADMIN}/${U(5)}`],
  ];
  const call = (token: string | null, [m, p, b]: (typeof routes)[number]) => {
    const rq = (h.http() as unknown as Record<string, (u: string) => Test>)[m]?.(p);
    if (rq === undefined) throw new Error("bad method");
    return rq.set({ ...(token === null ? {} : bearer(token)), ...idemKey() }).send((b ?? {}) as object);
  };

  it.each(routes.map((r) => [`${r[0].toUpperCase()} ${r[1]}`, r] as const))("%s: anonymous 401; shopper and seller tokens refused; support and finance 403; no passkey 403", async (_n, r) => {
    expect((await call(null, r)).status).toBe(401);
    expect((await call(TOKENS.shopper, r)).status).toBe(401);
    expect((await call(TOKENS.sellerOnAdmin, r)).status).toBe(401);
    expect((await call(TOKENS.support, r)).status).toBe(403);
    expect((await call(TOKENS.finance, r)).status).toBe(403);
    expect((await call(TOKENS.noPasskey, r)).status).toBe(403);
  });

  it("refuses non-shopper audiences on the shopper route and anonymous callers", async () => {
    expect((await h.http().get(SHOPPER)).status).toBe(401);
    expect((await h.http().get(SHOPPER).set(bearer(TOKENS.sellerOnAdmin))).status).toBe(401);
    expect((await h.http().get(SHOPPER).set(bearer(TOKENS.adminOnShopper))).status).toBe(401);
  });

  it("unknown ids are 404 for permitted roles", async () => {
    expect((await h.http().get(`${ADMIN}/${U(404)}`).set(bearer(TOKENS.marketing))).status).toBe(404);
    expect((await post(TOKENS.marketing, `${ADMIN}/${U(404)}/pause`)).status).toBe(404);
  });
});

describe("audit and idempotency", () => {
  it("writes the audit row before the change and fails closed (503, nothing written) when audit is down", async () => {
    const before = (await h.http().get(ADMIN).set(bearer(TOKENS.marketing))).body.items.length;
    h.audit.failNext = true;
    const r = await post(TOKENS.marketing, ADMIN, body());
    expect(r.status).toBe(503);
    expect((await h.http().get(ADMIN).set(bearer(TOKENS.marketing))).body.items.length).toBe(before);
    const ok = await post(TOKENS.marketing, ADMIN, body());
    expect(ok.status).toBe(201);
    expect(h.audit.entries.at(-1)).toMatchObject({ action: "home_banner.create", targetId: ok.body.id, actorId: U(21), targetType: "home_banner" });
    // Audit diffs carry ids and flags, never text.
    expect(JSON.stringify(h.audit.entries.at(-1))).not.toContain("خصم");
  });

  it("requires Idempotency-Key on writes and replays the same key without a second banner", async () => {
    const noKey = await h.http().post(ADMIN).set(bearer(TOKENS.marketing)).send(body());
    expect(noKey.status).toBe(400);
    const key = idemKey();
    const a = await h.http().post(ADMIN).set({ ...bearer(TOKENS.marketing), ...key }).send(body({ title: { ar: "مكرر" } }));
    const b = await h.http().post(ADMIN).set({ ...bearer(TOKENS.marketing), ...key }).send(body({ title: { ar: "مكرر" } }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    const reuse = await h.http().post(ADMIN).set({ ...bearer(TOKENS.marketing), ...key }).send(body({ title: { ar: "مختلف" } }));
    expect(reuse.status).toBe(422);
    const list = await h.http().get(ADMIN).set(bearer(TOKENS.marketing));
    expect(list.body.items.filter((i: { title: { ar: string } }) => i.title.ar === "مكرر")).toHaveLength(1);
  });
});

describe("kill switch kill.home_banners (allowed-when-true)", () => {
  it("answers an empty carousel (200) when blocked and keeps admin editing available", async () => {
    await live({ title: { ar: "ظاهر" } });
    expect((await h.http().get(SHOPPER).set(bearer(TOKENS.shopper))).body.items.length).toBeGreaterThan(0);
    h.flags.set(FLAG_HOME_BANNERS, false);
    const r = await h.http().get(SHOPPER).set(bearer(TOKENS.shopper));
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect((await h.http().get(ADMIN).set(bearer(TOKENS.marketing))).status).toBe(200);
  });
});

describe("guest read: GET /v1/public/home/banners (ADR-0055 G-4)", () => {
  const PUBLIC = "/v1/public/home/banners";
  const post2 = (token: string, path: string) => h.http().post(path).set({ ...bearer(token), ...idemKey() }).send({});

  it("answers 404 while flag.guest_browsing is blocked, even for a signed-in shopper", async () => {
    h.guest.on = false;
    expect((await h.http().get(PUBLIC)).status).toBe(404);
    expect((await h.http().get(PUBLIC).set(bearer(TOKENS.shopper))).status).toBe(404);
  });

  it("serves the live banners to anyone, cacheable, identical to the shopper projection, with no cookie and no server_time", async () => {
    h.guest.on = true;
    try {
      const id = await live();
      const anon = await h.http().get(PUBLIC);
      expect(anon.status).toBe(200);
      expect(Object.keys(anon.body)).toEqual(["items"]);
      const shopper = await h.http().get(SHOPPER).set(bearer(TOKENS.shopper));
      expect(anon.body.items).toEqual(shopper.body.items);
      expect(anon.body.items.length).toBeLessThanOrEqual(8);
      expect(anon.headers["cache-control"]).toMatch(/^public, max-age=0, s-maxage=30/);
      expect(anon.headers["set-cookie"]).toBeUndefined();
      const again = await h.http().get(PUBLIC).set({ "If-None-Match": anon.headers.etag as string });
      expect(again.status).toBe(304);
      // The caller's identity changes nothing (a bearer is ignored, the body is the same).
      expect((await h.http().get(PUBLIC).set(bearer(TOKENS.shopper))).body).toEqual(anon.body);
      await post2(TOKENS.marketing, `${ADMIN}/${id}/pause`);
      expect((await h.http().get(PUBLIC)).body.items.map((b: { id: string }) => b.id)).not.toContain(id);
      void id;
    } finally {
      h.guest.on = false;
    }
  });

  it("respects kill.home_banners: blocked means an empty list", async () => {
    h.guest.on = true;
    try {
      await live();
      h.flags.set(FLAG_HOME_BANNERS, false);
      expect((await h.http().get(PUBLIC)).body.items).toEqual([]);
    } finally {
      h.guest.on = false;
    }
  });

  it("also honours kill.public_catalog: 503 when the anonymous catalog is blocked", async () => {
    h.guest.on = true;
    h.publicCatalog.on = false;
    try {
      const r = await h.http().get(PUBLIC);
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("public_catalog_disabled");
    } finally {
      h.guest.on = false;
      h.publicCatalog.on = true;
    }
  });
});
