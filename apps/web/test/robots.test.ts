import { describe, expect, it } from "vitest";
import robots from "../src/app/robots";
import sitemap from "../src/app/sitemap";
import { UnconfiguredApiClient } from "../src/server/api-client";
import { tags } from "../src/server/cache-tags";

describe("robots", () => {
  const rules = robots().rules;
  const list = Array.isArray(rules) ? rules : [rules];
  const find = (ua: string) => list.find((r) => r.userAgent === ua);
  it("allows search bots and blocks training bots", () => {
    for (const ua of ["Googlebot", "Bingbot", "DuckDuckBot", "Applebot", "OAI-SearchBot", "PerplexityBot", "ChatGPT-User"]) expect(find(ua)?.allow).toBe("/");
    for (const ua of ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended", "Bytespider", "anthropic-ai", "Amazonbot"]) expect(find(ua)?.disallow).toBe("/");
  });
});

describe("sitemap", () => {
  it("lists only the market-locale roots with hreflang alternates", () => {
    const urls = sitemap().map((e) => new URL(e.url).pathname);
    expect(urls).toEqual(["/eg-ar", "/eg-en"]);
  });
});

describe("server layer", () => {
  it("UnconfiguredApiClient fails closed", async () => {
    const c = new UnconfiguredApiClient();
    expect(await c.getProduct()).toBeNull();
    expect(await c.getStore()).toBeNull();
    expect(await c.listStores()).toEqual({ stores: [], nextCursor: null, reason: "UNCONFIGURED" });
    expect(await c.listDeals()).toEqual([]);
    expect(await c.listCategories()).toEqual([]);
  });
  it("tag convention", () => {
    expect([tags.product("p1"), tags.store("s-1"), tags.market("eg")]).toEqual(["product:p1", "store:s-1", "market:eg"]);
  });
});
