import { describe, expect, it } from "vitest";
import { createClient, type FetchLike } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { ApiHomeBannersPort } from "./api";
import { ClientBannerAnalytics } from "./analytics";

const U = (n: number) => `0192f3a4-5b6c-7d8e-9f01-23456789ab${String(n).padStart(2, "0")}`;
const SERVER = "2026-10-12T10:00:00Z";
const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: U(n), title: { ar: "عرض", en: "Offer" }, sponsored: false,
  starts_at: "2026-10-12T00:00:00Z", ends_at: "2026-10-13T00:00:00Z", cta: { kind: "store", target_id: "store-1" }, ...over,
});

function setup(script: Array<() => Response>, deviceNow: { v: number }) {
  const seen: Array<Record<string, string>> = [];
  let i = 0;
  const fetch: FetchLike = async (_url, init) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    const r = script[Math.min(i++, script.length - 1)];
    if (r === undefined) throw new Error("no script");
    return r();
  };
  const client = createClient({ baseUrl: "https://api.test", fetch, getToken: () => "tok", sleep: async () => undefined, randomBytes: (n) => new Uint8Array(n).fill(3), maxRetries: 0 });
  const ctx: AdapterContext = { client, locale: () => "ar", nowMs: () => deviceNow.v, deviceId: () => "install-device-1" };
  return { port: new ApiHomeBannersPort(ctx), seen };
}
const ok = (items: unknown[], etag = '"v1"') =>
  () => new Response(JSON.stringify({ items, server_time: SERVER }), { status: 200, headers: { "Content-Type": "application/json", ETag: etag } });
const hdr = (h: Record<string, string>, k: string) => Object.entries(h).find(([n]) => n.toLowerCase() === k.toLowerCase())?.[1];

describe("ApiHomeBannersPort", () => {
  it("returns normalised banners and anchors the clock to server_time", async () => {
    const t = { v: 5_000 };
    const { port } = setup([ok([item(1, { art_variant: "festive", cta: { kind: "search", query: "linen", price_max: 50000 } }), item(2)])], t);
    const d = await port.load();
    expect(d.serverNowMs).toBe(Date.parse(SERVER));
    expect(d.banners.map((b) => b.id)).toEqual([U(1), U(2)]);
    expect(d.banners[0]?.art).toBe("eid");
    expect(d.banners[0]?.cta).toMatchObject({ kind: "search", query: "linen", priceMax: 50000 });
  });

  it("drops malformed items (client-side rules the schema does not enforce)", async () => {
    const { port } = setup([ok([item(1, { starts_at: "2026-10-14T00:00:00Z" }), item(2)])], { v: 0 });
    expect((await port.load()).banners.map((b) => b.id)).toEqual([U(2)]);
  });

  it("sends If-None-Match and reuses the last list on 304 with the server clock advanced by elapsed time", async () => {
    const t = { v: 1_000 };
    const { port, seen } = setup([ok([item(1)]), () => new Response(null, { status: 304, headers: { ETag: '"v1"' } })], t);
    await port.load();
    t.v = 31_000;
    const d = await port.load();
    expect(hdr(seen[1] ?? {}, "If-None-Match")).toBe('"v1"');
    expect(hdr(seen[0] ?? {}, "If-None-Match")).toBeUndefined();
    expect(d.banners).toHaveLength(1);
    expect(d.serverNowMs).toBe(Date.parse(SERVER) + 30_000);
  });

  it("returns the last good list on error, and an empty list when there is none", async () => {
    const t = { v: 0 };
    const fail = () => new Response(JSON.stringify({ type: "/problems/internal", title: "x", status: 500 }), { status: 500, headers: { "Content-Type": "application/problem+json" } });
    const a = setup([fail], t);
    expect((await a.port.load()).banners).toEqual([]);
    const b = setup([ok([item(1)]), fail], t);
    await b.port.load();
    t.v = 10_000;
    const d = await b.port.load();
    expect(d.banners).toHaveLength(1);
    expect(d.serverNowMs).toBe(Date.parse(SERVER) + 10_000);
  });

  it("an off-contract body degrades to empty instead of throwing", async () => {
    const { port } = setup([() => new Response(JSON.stringify({ nope: true }), { status: 200, headers: { "Content-Type": "application/json" } })], { v: 0 });
    expect((await port.load()).banners).toEqual([]);
  });
});

describe("ClientBannerAnalytics", () => {
  it("forwards typed, PII-free properties and never throws", async () => {
    const sent: Array<[string, unknown]> = [];
    const a = new ClientBannerAnalytics({ track: async (n, p) => { sent.push([n, p]); return false; } });
    a.impression({ bannerId: "b-12345678", position: 1, kind: "drop", sponsored: true });
    a.click({ bannerId: "b-12345678", position: 1, kind: "drop", sponsored: true });
    expect(sent).toEqual([
      ["home_banner_impression", { banner_id: "b-12345678", position: 1, sponsored: true, cta_kind: "drop" }],
      ["home_banner_click", { banner_id: "b-12345678", position: 1, sponsored: true, cta_kind: "drop" }],
    ]);
    const bad = new ClientBannerAnalytics({ track: () => Promise.reject(new Error("x")) });
    expect(() => bad.click({ bannerId: "b-12345678", position: 0, kind: "store", sponsored: false })).not.toThrow();
  });
});
