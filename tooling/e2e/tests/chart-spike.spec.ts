import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP, setLocaleOnly } from "./helpers";

// Chart spike (docs/research/chart-spike-results.md). Admin only. Needs a PRODUCTION build served with ADMIN_CHART_SPIKE=1
// (E2E_PROD=1 and ADMIN_CHART_SPIKE=1 with tooling/e2e/run.sh admin, or `next start` directly with E2E_BASE set).
// It MEASURES per library (one library per page load) and writes test-results/chart-spike-findings.json (override: SPIKE_OUT). With SPIKE_STRICT=1 it also
// asserts zero CSP violations for the libraries listed in SPIKE_STRICT_LIBS (default: all but recharts-csr).
test.skip(APP !== "admin", "admin only");

const LIBS = ["none", "echarts", "svg", "recharts", "recharts-csr"] as const;
type Lib = (typeof LIBS)[number];
// Written inside the workspace (gitignored test-results), never a predictable name in the shared OS temp dir.
const OUT = process.env.SPIKE_OUT ?? path.resolve(__dirname, "../../../test-results/chart-spike-findings.json");
mkdirSync(path.dirname(OUT), { recursive: true });
const findings: Record<string, unknown> = {};
const shots = path.resolve(__dirname, "../../../docs/research/chart-spike-screenshots");

interface Viol { directive: string; blocked: string; sample: string }

interface PageState { errors: string[]; sizes: Map<string, { raw: number; gzip: number }> }
// Listeners and the init script are registered once per page; open() only resets the per-navigation collectors.
const registered = new WeakMap<Page, PageState>();

function register(page: Page): PageState {
  const existing = registered.get(page);
  if (existing !== undefined) return existing;
  const st: PageState = { errors: [], sizes: new Map() };
  page.on("console", (m) => { if (m.type() === "error" && !/Content[- ]Security[- ]Policy/i.test(m.text())) st.errors.push(m.text()); });
  page.on("pageerror", (e) => st.errors.push(`uncaught: ${e.message}`));
  page.on("response", (r) => {
    if (r.request().resourceType() !== "script") return;
    void r.body().then((b) => st.sizes.set(r.url(), { raw: b.length, gzip: gzipSync(b).length })).catch(() => undefined);
  });
  // Runs in every new document of this page; resets the violation list per navigation.
  void page.addInitScript(() => {
    const w = window as unknown as { __v: Viol[] };
    w.__v = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__v.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: (e.sample ?? "").slice(0, 80) }));
  });
  registered.set(page, st);
  return st;
}

async function open(page: Page, lib: Lib, extra = ""): Promise<{ viol: () => Promise<Viol[]>; errors: string[]; js: () => { raw: number; gzip: number; files: number } }> {
  const st = register(page);
  st.errors.length = 0;
  st.sizes.clear();
  const res = await page.goto(`/spike/charts?only=${lib}${extra}`);
  expect(res?.status()).toBe(200);
  expect(res?.headers()["content-security-policy"] ?? "").toMatch(/'nonce-/);
  expect(res?.headers()["content-security-policy"] ?? "").not.toContain("unsafe-eval");
  expect(res?.headers()["content-security-policy"] ?? "").not.toContain("unsafe-inline");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  return {
    viol: () => page.evaluate(() => (window as unknown as { __v: Viol[] }).__v),
    errors: st.errors,
    js: () => { const v = [...st.sizes.values()]; return { raw: v.reduce((a, b) => a + b.raw, 0), gzip: v.reduce((a, b) => a + b.gzip, 0), files: v.length }; },
  };
}

for (const lib of LIBS) {
  test(`spike ${lib}: CSP, bundle, axe, keyboard, toggles`, async ({ page, context }, info) => {
    test.skip(info.project.name !== "desktop", "measured once, desktop");
    await setLocaleOnly(context, "en");
    const p = await open(page, lib);
    const viol = await p.viol();
    const figures = await page.locator("figure").count();
    const styleAttrs = await page.evaluate(() => Array.from(document.querySelectorAll("figure [style]")).filter((e) => !e.closest("[hidden]")).length);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const axeBad = axe.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`);
    // keyboard: every figure toggle reachable by Tab and operable by Enter; table appears and carries the same row count
    const toggles = page.locator("figure button[aria-pressed]");
    const n = await toggles.count();
    let tableOk = 0;
    for (let i = 0; i < n; i++) {
      const b = toggles.nth(i);
      await b.focus();
      await expect(b).toHaveAttribute("aria-pressed", "false");
      const nameBefore = await b.textContent();
      await page.keyboard.press("Enter");
      await expect(b).toHaveAttribute("aria-pressed", "true");
      expect(await b.textContent(), "toggle name is fixed; state is aria-pressed only").toBe(nameBefore);
      const fig = page.locator("figure").nth(i);
      if (await fig.locator("table").count() > 0 && await fig.locator("table tbody tr").count() > 0) tableOk += 1;
      await page.keyboard.press("Enter");
      await expect(b).toHaveAttribute("aria-pressed", "false");
    }
    const focusableInChart = await page.evaluate(() => Array.from(document.querySelectorAll("figure svg[tabindex], figure svg [tabindex], figure [data-chart] [tabindex]")).length);
    const styleSamples = await page.evaluate(() => Array.from(document.querySelectorAll("[style]")).filter((e) => !e.closest("[data-chart]") && !e.closest("dialog")).slice(0, 4).map((e) => e.outerHTML.slice(0, 140)));
    findings[lib] = { styleAttrSamplesOutsideEChartsContainers: styleSamples, violations: viol, violationCount: viol.length, styleAttrsInVisibleFigures: styleAttrs, figures, togglesOk: `${tableOk}/${n}`, focusableInsideChart: focusableInChart, axe: axeBad, consoleErrors: p.errors, js: p.js() };
    if (process.env.SPIKE_STRICT === "1" && (process.env.SPIKE_STRICT_LIBS ?? "none,echarts,svg").split(",").includes(lib)) expect(viol, "CSP violations").toEqual([]);
    writeFileSync(OUT, JSON.stringify(findings, null, 2));
  });
}

test("spike echarts tooltips on hover under CSP", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await setLocaleOnly(context, "en");
  const out: Record<string, unknown> = {};
  for (const name of ["echarts-line", "echarts-line-richtext", "echarts-line-notooltip"]) {
    const p = await open(page, "echarts");
    const loc = page.locator(`[data-chart="${name}"]`);
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.boundingBox();
    expect(box).not.toBeNull();
    const before = (await p.viol()).length;
    const probe = (el: Element): { tag: string; text: string } | null => {
      // A tooltip shows the series name followed by a value, in a rendered (not hidden) element that is not the chart's text alternative.
      const re = /Orders\D{0,8}\d{2,}/;
      const visible = (e: Element): boolean => {
        const cs = getComputedStyle(e);
        return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0 && !e.closest("[hidden],[aria-hidden='true']");
      };
      // HTML tooltip: an element whose text has the series name followed by a value. richText tooltip: an SVG <text>/<tspan> reading "Orders".
      const ok = (d: Element): boolean => (d.tagName === "text" || d.tagName === "tspan" ? /^\s*Orders\b/.test(d.textContent ?? "") : re.test(d.textContent ?? "")) && visible(d) && !d.closest("title,desc");
      const matches = Array.from(el.querySelectorAll("div,span,text,tspan")).filter((d) => d !== el && ok(d));
      const hit = matches.find((d) => !matches.some((o) => o !== d && d.contains(o))); // innermost match
      return hit ? { tag: hit.tagName, text: (hit.textContent ?? "").slice(0, 50) } : null;
    };
    const tipBefore = await loc.evaluate(probe);
    if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 5); }
    await page.waitForTimeout(600);
    const tipAfter = await loc.evaluate(probe);
    const tip = tipBefore === null ? tipAfter : null; // only a tooltip that appeared on hover counts
    const after = await p.viol();
    if (name === "echarts-line-notooltip") expect(tip, "no tooltip configured").toBeNull(); else expect(tip, `${name} tooltip appears on hover`).not.toBeNull();
    out[name] = { newViolationsAfterHover: after.length - before, directives: [...new Set(after.slice(before).map((v) => v.directive))], tooltipVisible: tip };
  }
  findings["echartsTooltips"] = out;
  writeFileSync(OUT, JSON.stringify(findings, null, 2));
});

test("spike dialog: focus trap and Escape", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await setLocaleOnly(context, "en");
  await open(page, "none");
  await page.getByRole("button", { name: "Open dialog" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Open dialog");
  findings["dialog"] = { focusTrapped: true, escapeCloses: true, focusReturnsToOpener: true };
  writeFileSync(OUT, JSON.stringify(findings, null, 2));
});

test("spike perf: 5k marks", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await setLocaleOnly(context, "en");
  const out: Record<string, unknown> = {};
  for (const [lib, name] of [["echarts", "echarts-perf"], ["recharts", "recharts-perf"]] as const) {
    await open(page, lib, "&perf=1");
    await page.waitForTimeout(800);
    out[lib] = await page.evaluate((n) => { const e = document.querySelector(`[data-perf="${n}"]`) as HTMLElement | null; return e ? { mountMs: e.dataset["renderMs"], svgNodes: e.dataset["svgNodes"] } : null; }, name);
  }
  findings["perf5k"] = out;
  writeFileSync(OUT, JSON.stringify(findings, null, 2));
});

test("spike RTL screenshots (ar)", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await setLocaleOnly(context, "ar");
  mkdirSync(shots, { recursive: true });
  const out: Record<string, unknown> = {};
  for (const lib of ["echarts", "svg", "recharts"] as const) {
    await open(page, lib);
    expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
    await page.screenshot({ path: path.join(shots, `spike-${lib}-ar.png`), fullPage: true });
    out[lib] = await page.evaluate(() => {
      const f = document.querySelector("figure svg");
      const r = f?.getBoundingClientRect();
      const texts = Array.from(document.querySelectorAll("figure svg text")).slice(0, 40).map((t) => ({ t: t.textContent, x: Math.round(t.getBoundingClientRect().x) }));
      return { firstSvgX: r ? Math.round(r.x) : null, bodyDirection: getComputedStyle(document.body).direction, sampleTexts: texts.slice(0, 12) };
    });
  }
  findings["rtl"] = out;
  writeFileSync(OUT, JSON.stringify(findings, null, 2));
});
