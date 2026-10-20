import { expect, type Page, type BrowserContext, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const APP = process.env.E2E_APP ?? "seller";
export const BASE = process.env.E2E_BASE ?? "http://localhost:3001";
const far = Date.now() + 365 * 864e5;
const state = { accessToken: "e2e-access", refreshToken: "e2e-refresh", accessExpiresAtMs: far, secondFactorRequired: false };
const cookieVal = Buffer.from(JSON.stringify(state)).toString("base64url");

export async function signIn(ctx: BrowserContext, locale: "ar" | "en"): Promise<void> {
  const url = BASE;
  await ctx.addCookies(APP === "seller"
    ? [{ name: "sc_session", value: cookieVal, url }, { name: "sc_locale", value: locale, url }]
    : [{ name: "__Host-admin-session", value: cookieVal, domain: "localhost", path: "/", secure: true }, { name: "admin-locale", value: locale, url }]);
}
export async function setLocaleOnly(ctx: BrowserContext, locale: "ar" | "en"): Promise<void> {
  await ctx.addCookies([{ name: APP === "seller" ? "sc_locale" : "admin-locale", value: locale, url: BASE }]);
}

export interface Probe { errors: string[]; failed: string[]; violations: string[] }
export function probe(page: Page, allowStatuses: number[] = []): Probe {
  const p: Probe = { errors: [], failed: [], violations: [] };
  page.on("console", (m) => { if (m.type() === "error") p.errors.push(m.text()); });
  page.on("pageerror", (e) => p.errors.push(`uncaught: ${e.message}`));
  page.on("requestfailed", (r) => { if (!/_rsc|_next\/webpack-hmr/.test(r.url()) && r.failure()?.errorText !== "net::ERR_ABORTED") p.failed.push(`${r.url()} ${r.failure()?.errorText}`); });
  page.on("response", (r) => { if (r.status() >= 400 && !allowStatuses.includes(r.status())) p.failed.push(`${r.status()} ${r.url()}`); });
  void page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return p;
}

/** Heuristic a11y scan (axe-core is not installed). Returns serious findings. */
export async function a11yHeuristics(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const name = (el: Element): string => (el.getAttribute("aria-label") ?? el.getAttribute("aria-labelledby") ?? el.textContent ?? "").trim();
    if (!document.documentElement.lang) out.push("html missing lang");
    if (document.querySelectorAll("main,[role=main]").length !== 1) out.push("expected exactly one main landmark");
    if (document.querySelectorAll("h1").length < 1) out.push("no h1");
    document.querySelectorAll("img").forEach((i) => { if (!i.hasAttribute("alt")) out.push("img without alt"); });
    document.querySelectorAll("button,a[href]").forEach((b) => { if (!name(b) && !b.querySelector("img[alt]")) out.push(`unnamed ${b.tagName}`); });
    document.querySelectorAll("input:not([type=hidden]),select,textarea").forEach((f) => {
      const id = f.id; const lab = id && document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (!lab && !f.closest("label") && !f.getAttribute("aria-label") && !f.getAttribute("aria-labelledby")) out.push(`unlabelled ${f.tagName}#${id}`);
    });
    const ids = new Map<string, number>(); document.querySelectorAll("[id]").forEach((e) => ids.set(e.id, (ids.get(e.id) ?? 0) + 1));
    ids.forEach((n, id) => { if (n > 1) out.push(`duplicate id ${id}`); });
    return out;
  });
}

export async function checkPage(page: Page, info: TestInfo, urlPath: string, locale: "ar" | "en", opts: { allow?: number[]; shot?: string } = {}): Promise<Probe> {
  const p = probe(page, opts.allow);
  const res = await page.goto(urlPath);
  await page.waitForLoadState("networkidle");
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp, "CSP header").toMatch(/'nonce-[A-Za-z0-9+/_=-]+'/);
  const viol = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  expect(viol, "CSP violations").toEqual([]);
  expect(await page.locator("html").getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr");
  expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe(locale === "ar" ? "rtl" : "ltr");
  // keyboard: Tab must reach an interactive element inside main within 40 presses
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => !!document.activeElement?.closest("main,[role=main]") && document.activeElement !== document.body);
  }
  if (await page.locator("main a, main button, main input, main select, main textarea").count() > 0) expect(reached, "Tab reaches main action").toBe(true);
  const vw = page.viewportSize()?.width ?? 1440;
  const overflow = await page.evaluate((w) => {
     const bad: string[] = [];
    document.querySelectorAll("body *").forEach((e) => { const r = e.getBoundingClientRect(); if (r.width > 0 && (r.right > w + 1 || r.left < -1) && !e.closest(".tablewrap,.table-wrap,[class*=skip]")) bad.push(`${e.tagName}.${e.className}`); });
    return document.documentElement.scrollWidth > w + 1 ? bad.slice(0, 5) : [];
  }, vw);
  expect(overflow, "horizontal page overflow").toEqual([]);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const bad = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" ; ")}`);
  expect(bad, "axe serious/critical").toEqual([]);
  const heur = await a11yHeuristics(page);
  expect(heur, "a11y heuristics").toEqual([]);
  const name = opts.shot ?? `web-${APP}-${urlPath.replace(/\W+/g, "_") || "root"}-${locale}-${info.project.name}`;
  const dir = path.resolve(__dirname, "../../../docs/design-system/screenshots");
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
  expect(p.errors, "console errors").toEqual([]);
  expect(p.failed, "failed requests").toEqual([]);
  return p;
}
void writeFileSync;
