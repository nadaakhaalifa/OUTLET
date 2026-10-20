import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { id as seedId } from "./adapters/dev-seed";
import { createStoresHarness, type StoresHarness } from "./test/harness";

const S = (n: number) => seedId(n);
const MISSING = "0192f3a4-5b6c-7d8e-9f01-0000000000ff";

/** Allow-list snapshot: the complete set of keys an anonymous caller may ever receive for a store. */
const SUMMARY_KEYS = [
  "cover_url", "follower_count", "id", "kind", "live_drop", "logo_url", "max_verified_discount_pct", "name",
  "rating", "rating_count", "slug", "verified_badge",
];
const DETAIL_KEYS = [...SUMMARY_KEYS, "description", "free_delivery_threshold", "legal_identity", "status"];
const FORBIDDEN = ["is_favorite", "seller_id", "health_badge", "health_score", "kyc", "iban", "phone", "email", "national_id", "signatory"];

let h: StoresHarness;
beforeAll(async () => {
  h = await createStoresHarness();
});
afterAll(async () => h.close());

describe("GET /v1/public/stores (anonymous)", () => {
  it("answers without credentials and lists only ACTIVE approved stores (vacation, suspended, draft are absent)", async () => {
    const r = await h.http().get("/v1/public/stores?limit=50");
    expect(r.status).toBe(200);
    const ids: string[] = r.body.items.map((i: { id: string }) => i.id);
    // Stores 1-5 are ACTIVE; 6 is on vacation (PAUSED); 7-10 are suspended, draft, KYC-suspended or identity-less.
    expect(ids.sort()).toEqual([S(1), S(2), S(3), S(4), S(5)].sort());
    for (const hidden of [6, 7, 8, 9, 10]) expect(ids).not.toContain(S(hidden));
  });

  it("returns exactly the allow-listed keys, never a per-user or internal field", async () => {
    const r = await h.http().get("/v1/public/stores?limit=50");
    for (const item of r.body.items as Record<string, unknown>[]) {
      for (const k of Object.keys(item)) expect(SUMMARY_KEYS, k).toContain(k);
      for (const f of FORBIDDEN) expect(item, f).not.toHaveProperty(f);
    }
    expect(JSON.stringify(r.body)).not.toMatch(/is_favorite|seller_id|sellerId/);
    expect(Object.keys(r.body).sort()).toEqual(["items", "page"]);
  });

  it("ignores credentials entirely: a bearer token changes nothing and no cookie is ever set", async () => {
    const anon = await h.http().get("/v1/public/stores?limit=50");
    const withBearer = await h.http().get("/v1/public/stores?limit=50").set("Authorization", "Bearer not-a-token").set("Cookie", "sid=abc");
    expect(withBearer.status).toBe(200);
    expect(withBearer.body).toEqual(anon.body);
    expect(anon.headers["set-cookie"]).toBeUndefined();
    expect(anon.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("is CDN cacheable with a validator and answers 304", async () => {
    const r = await h.http().get("/v1/public/stores");
    expect(r.headers["cache-control"]).toMatch(/^public, max-age=0, s-maxage=\d+, stale-while-revalidate=\d+$/);
    expect(r.headers.etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await h.http().get("/v1/public/stores").set("If-None-Match", String(r.headers.etag));
    expect(again.status).toBe(304);
  });

  it("filters by world, paginates with a bound cursor and rejects unknown or oversized parameters", async () => {
    const local = await h.http().get("/v1/public/stores?world=local&limit=50");
    expect(local.body.items.map((i: { id: string }) => i.id).sort()).toEqual([S(1), S(2), S(3)].sort());
    const p1 = await h.http().get("/v1/public/stores?world=everything&limit=2");
    expect(p1.body.page.has_more).toBe(true);
    const p2 = await h.http().get(`/v1/public/stores?world=everything&limit=2&cursor=${String(p1.body.page.next_cursor)}`);
    expect(p2.status).toBe(200);
    const seen = [...p1.body.items, ...p2.body.items].map((i: { id: string }) => i.id);
    expect(new Set(seen).size).toBe(seen.length);
    // my_stores is personal and is not part of the public surface.
    expect((await h.http().get("/v1/public/stores?world=my_stores")).status).toBe(400);
    expect((await h.http().get("/v1/public/stores?limit=51")).status).toBe(400);
    expect((await h.http().get("/v1/public/stores?limit=0")).status).toBe(400);
    expect((await h.http().get("/v1/public/stores?debug=1")).status).toBe(400);
    expect((await h.http().get("/v1/public/stores?cursor=!!!")).status).toBe(400);
    // A cursor minted for another ordering is refused.
    expect((await h.http().get(`/v1/public/stores?sort=name&cursor=${String(p1.body.page.next_cursor)}`)).status).toBe(400);
  });
});

describe("GET /v1/public/stores/{storeId}", () => {
  it("returns the legal identity and exactly the allow-listed keys for an active store", async () => {
    const r = await h.http().get(`/v1/public/stores/${S(1)}`);
    expect(r.status).toBe(200);
    for (const k of Object.keys(r.body)) expect(DETAIL_KEYS, k).toContain(k);
    for (const f of FORBIDDEN) expect(r.body).not.toHaveProperty(f);
    expect(r.body.status).toBe("active");
    expect(Object.keys(r.body.legal_identity).sort()).toEqual(["commercial_register_no", "governorate", "legal_name", "tax_id"]);
    expect(r.headers["cache-control"]).toMatch(/s-maxage=60/);
  });

  it("cannot enumerate non-public stores: vacation, suspended, draft, unapproved and missing are the same 404", async () => {
    const missing = await h.http().get(`/v1/public/stores/${MISSING}`);
    expect(missing.status).toBe(404);
    for (const n of [6, 7, 8, 9, 10]) {
      const r = await h.http().get(`/v1/public/stores/${S(n)}`);
      expect(r.status, `store ${n}`).toBe(404);
      expect({ ...r.body, request_id: undefined }).toEqual({ ...missing.body, request_id: undefined });
    }
    expect((await h.http().get("/v1/public/stores/not-a-uuid")).status).toBe(400);
  });
});

describe("GET /v1/public/sitemap/stores/{page}", () => {
  it("lists only public store ids and slugs with page bounds", async () => {
    const r = await h.http().get("/v1/public/sitemap/stores/1");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["items", "page"]);
    expect((r.body.items as { id: string }[]).map((i) => i.id).sort()).toEqual([S(1), S(2), S(3), S(4), S(5)].sort());
    for (const i of r.body.items as Record<string, unknown>[]) expect(Object.keys(i).sort()).toEqual(["id", "slug"]);
    expect(r.body.page).toEqual({ number: 1, next_page: null });
    expect((await h.http().get("/v1/public/sitemap/stores/0")).status).toBe(400);
    expect((await h.http().get("/v1/public/sitemap/stores/1001")).status).toBe(400);
    expect((await h.http().get("/v1/public/sitemap/stores/abc")).status).toBe(400);
    expect((await h.http().get("/v1/public/sitemap/stores/999")).body.items).toEqual([]);
  });
});

describe("existing authenticated routes are unchanged", () => {
  it("GET /v1/stores and /v1/stores/{id} still answer 401 without a token and still list the vacation store when signed in", async () => {
    expect((await h.http().get("/v1/stores?world=everything")).status).toBe(401);
    expect((await h.http().get(`/v1/stores/${S(1)}`)).status).toBe(401);
    const l = await h.loginAs("+201001110055");
    const r = await h.http().get("/v1/stores?world=everything&limit=50").set("Authorization", `Bearer ${l.accessToken}`);
    expect((r.body.items as { id: string }[]).map((i) => i.id)).toContain(S(6));
  });
});

describe("per-IP rate limit", () => {
  it("answers 429 with Retry-After once the sitemap budget (60 per minute) is spent", async () => {
    let last = 0;
    let retry: unknown;
    for (let i = 0; i < 70; i += 1) {
      const r = await h.http().get("/v1/public/sitemap/stores/1");
      last = r.status;
      if (r.status === 429) {
        retry = r.headers["retry-after"];
        break;
      }
    }
    expect(last).toBe(429);
    expect(retry).toBeDefined();
  });
});
