import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { APP, a11yHeuristics, probe } from "./helpers";

test.skip(APP !== "shopper", "shopper only");

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STORE = `nile-outlet-${U(801)}`;
const PAGES: { name: string; path: string }[] = [
  { name: "home", path: "" },
  { name: "drops", path: "/drops" },
  { name: "drop-live", path: `/drops/${U(820)}` },
  { name: "drop-mystery", path: `/drops/${U(821)}` },
  { name: "store", path: `/s/${STORE}` },
  { name: "product-verified", path: `/p/linen-dress-${U(810)}` },
  { name: "product-plain", path: `/p/cotton-shirt-${U(811)}` },
  { name: "search", path: "/search?q=dress" },
];
const SHOTS = path.resolve(__dirname, "../../../docs/design-system/screenshots");

async function gate(page: Page, urlPath: string, locale: "ar" | "en"): Promise<void> {
  const p = probe(page);
  const res = await page.goto(`/${locale}${urlPath}`);
  expect(res?.status(), "status").toBe(200);
  await page.waitForLoadState("networkidle");
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []), "CSP violations").toEqual([]);
  expect(await page.locator("html").getAttribute("lang")).toBe(locale);
  expect(await page.locator("html").getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr");
  const vw = page.viewportSize()?.width ?? 1440;
  expect(await page.evaluate((w) => document.documentElement.scrollWidth > w + 1, vw), "horizontal overflow").toBe(false);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const bad = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} x${v.nodes.length}`);
  expect(bad, "axe serious/critical").toEqual([]);
  expect(await a11yHeuristics(page), "heuristics").toEqual([]);
  expect(p.errors, "console errors").toEqual([]);
  expect(p.failed, "failed requests").toEqual([]);
}

for (const locale of ["ar", "en"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    for (const pg of PAGES) {
      test(`${pg.name} ${locale} ${scheme}`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: scheme });
        await gate(page, pg.path, locale);
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS, `web-shopper-${pg.name}-${locale}-${scheme}-${info.project.name}.png`), fullPage: true });
      });
    }
  }
}

test.describe("SEO and honesty", () => {
  test("verified product: strike-through present, JSON-LD has offer only", async ({ page }) => {
    await page.goto(`/en/p/linen-dress-${U(810)}`);
    await expect(page.locator("main del")).toHaveCount(1);
    const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
    const product = ld.map((t) => JSON.parse(t) as Record<string, unknown>).find((j) => j["@type"] === "Product");
    expect(product).toBeDefined();
    const offer = (product as { offers: Record<string, unknown> }).offers;
    expect(offer.price).toBe("999.00");
    expect(offer.priceCurrency).toBe("EGP");
    const raw = JSON.stringify(product);
    expect(raw).not.toMatch(/priceValidUntil|aggregateRating|review|1299/);
  });
  test("product without evidence: no strike-through and no discount text", async ({ page }) => {
    await page.goto(`/en/p/cotton-shirt-${U(811)}`);
    await expect(page.locator("main del")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(/%/);
  });
  test("canonical and hreflang are self-consistent", async ({ page }) => {
    for (const locale of ["ar", "en"]) {
      await page.goto(`/${locale}/p/linen-dress-${U(810)}`);
      const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
      expect(canonical).toContain(`/${locale}/p/`);
      const alts = await page.locator('link[rel="alternate"][hreflang]').evaluateAll((els) => els.map((e) => [e.getAttribute("hreflang"), e.getAttribute("href")]));
      const map = Object.fromEntries(alts);
      expect(Object.keys(map).sort()).toEqual(["ar-EG", "en", "x-default"]);
      expect(map[locale === "ar" ? "ar-EG" : "en"]).toBe(canonical);
    }
  });
  test("no analytics or third-party requests, no cookies set", async ({ page, context }) => {
    const hosts = new Set<string>();
    page.on("request", (r) => hosts.add(new URL(r.url()).host));
    await page.goto("/ar");
    await page.waitForLoadState("networkidle");
    expect([...hosts]).toEqual([new URL(page.url()).host]);
    expect(await context.cookies()).toEqual([]);
  });
  test("robots, sitemap, locale redirect", async ({ request }) => {
    const robots = await request.get("/robots.txt");
    expect(await robots.text()).toMatch(/Disallow: \/api\/[\s\S]*Sitemap:/);
    const sm = await (await request.get("/sitemap.xml")).text();
    expect(sm).toContain(`/ar/p/${U(810)}`);
    expect(sm).toContain(`/ar/s/nile-outlet-${U(801)}`);
    expect(sm).toMatch(/<lastmod>/);
    expect(sm).toContain("hreflang=\"en\"");
    const r = await request.get("/", { maxRedirects: 0 });
    expect([307, 308]).toContain(r.status());
  });
  test("search results are noindex; unknown product is 404", async ({ page }) => {
    await page.goto("/en/search?q=dress");
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toMatch(/noindex/);
    const res = await page.goto(`/en/p/missing-${U(999)}`);
    expect(res?.status()).toBe(404);
  });
  test("delisted product (API 410) answers 404 and suspended store (API 404) answers 404", async ({ page }) => {
    const gone = await page.goto(`/en/p/${U(812)}`);
    expect(gone?.status()).toBe(404);
    const suspended = await page.goto(`/en/s/suspended-${U(802)}`);
    expect(suspended?.status()).toBe(404);
  });
  test("canonical product URL is id-only and slugged links redirect to it", async ({ page }) => {
    await page.goto(`/en/p/linen-dress-${U(810)}`);
    expect(page.url()).toMatch(new RegExp(`/en/p/${U(810)}$`));
  });
});
