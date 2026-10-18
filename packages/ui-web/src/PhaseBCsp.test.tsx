// Real Chromium enforcing the production admin CSP (buildCsp, non-development) over server-rendered Phase B charts.
// Needs a Playwright Chromium install; if launch fails the suite FAILS (it is not skipped silently).
import { renderToStaticMarkup as html } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { AgingBars, BarH, ChartFrame, IntervalPlot, StackedBar } from "./index";
import { ADMIN_CSS, uiWebCss } from "./css";
import { colorVars, motionVars } from "./tokens-css";
import { colors } from "@outlet/ui-tokens";
import { contrast } from "./contrast";

const NONCE = "dGVzdG5vbmNlMTIzNDU2Nzg5MA==";
const f = (n: number): string => new Intl.NumberFormat("ar-EG").format(n);

function body(mirror: boolean): string {
  return html(
    <main>
      <ChartFrame title="t" summary="s" viewAsTableLabel="جدول"
        chart={<BarH label="ترتيب" mirror={mirror} rows={[{ label: "أ", value: 1234 }, { label: "ب", value: null }]} format={f} notLoadedText="لم يُحمَّل" />}
        table={{ caption: "c", columns: [{ key: "a", header: "h", cell: (r: { a: string }) => r.a }], rows: [{ a: "أ" }], rowKey: (r) => r.a }} />
      <StackedBar label="حالات" mirror={mirror} segments={[{ label: "أ", value: 3 }, { label: "ب", value: 2 }, { label: "ج", value: 1 }, { label: "د", value: 1 }, { label: "هـ", value: 1 }]} format={f} />
      <AgingBars label="تقادم" mirror={mirror} buckets={[{ label: "١", count: 3 }, { label: "٢", count: 1 }, { label: "٣", count: 9 }]} format={f} referenceBoundary={1} referenceLabel="حد" />
      <IntervalPlot label="توقع" mirror={mirror} rows={[{ label: "أ", interval: { p10: 1, p50: 2, p90: 4 } }]} format={f} />
    </main>,
  );
}
// Admin naming (`--brand`, `--sp-*`), as apps/admin-web/src/app/styles.ts emits it, forced per scheme.
const adminVars = (dark: boolean): string => `:root{${colorVars(colors[dark ? "dark" : "light"], "--")}${motionVars()}--tap:44px;}`;
const page = (mirror: boolean, dark: boolean): string =>
  `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style nonce="${NONCE}">${adminVars(dark)}${uiWebCss(ADMIN_CSS)}body{background:var(--background);color:var(--text-primary)}</style></head><body data-theme="${dark ? "dark" : "light"}">${body(mirror)}<script nonce="${NONCE}">window.__ok=1</script></body></html>`;

// Loaded by path so ui-web's tsc does not typecheck admin-web sources (different lib settings).
const CSP_MODULE = "../../../apps/admin-web/src/security/csp";
type BuildCsp = (o: { nonce: string; development: boolean; apiOrigin: string | null }) => string;
let buildCsp: BuildCsp;
let browser: Browser;
beforeAll(async () => { buildCsp = ((await import(/* @vite-ignore */ CSP_MODULE)) as { buildCsp: BuildCsp }).buildCsp; browser = await chromium.launch(); }, 60_000);
afterAll(async () => { await browser?.close(); });

async function open(opts: { mirror?: boolean; dark?: boolean; reduced?: boolean } = {}): Promise<{ p: Page; violations: string[] }> {
  const ctx = await browser.newContext({ colorScheme: opts.dark === true ? "dark" : "light", reducedMotion: opts.reduced === true ? "reduce" : "no-preference" });
  const p = await ctx.newPage();
  const violations: string[] = [];
  await p.addInitScript(() => {
    const w = window as unknown as { __v: string[] };
    w.__v = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__v.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample}`));
  });
  const csp = buildCsp({ nonce: NONCE, development: false, apiOrigin: null });
  await p.route("http://app.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", headers: { "content-security-policy": csp }, body: page(opts.mirror === true, opts.dark === true) }));
  p.on("console", (m) => { if (/Content Security Policy|Refused/i.test(m.text())) violations.push(m.text()); });
  await p.goto("http://app.test/");
  await p.waitForTimeout(150);
  violations.push(...(await p.evaluate(() => (window as unknown as { __v: string[] }).__v)));
  return { p, violations };
}

describe("production CSP, real Chromium", () => {
  it("script-src nonce works (control: proves CSP is active and nonce path executes)", async () => {
    const { p } = await open();
    expect(await p.evaluate(() => (window as unknown as { __ok?: number }).__ok)).toBe(1);
    await p.context().close();
  }, 30_000);
  it("CSP is really enforced: an injected inline style attribute IS reported (negative control)", async () => {
    const { p } = await open();
    await p.evaluate(() => { document.querySelector("svg")!.setAttribute("style", "fill:red"); });
    await p.waitForTimeout(100);
    // setAttribute('style') is blocked by style-src-attr and reported
    const v = await p.evaluate(() => (window as unknown as { __v: string[] }).__v);
    expect(v.join("|")).toMatch(/style-src/);
    await p.context().close();
  }, 30_000);
  for (const mirror of [false, true]) {
    it(`zero CSP violations, LTR and RTL (mirror=${mirror}); charts styled by CSS classes`, async () => {
      const { p, violations } = await open({ mirror });
      expect(violations).toEqual([]);
      expect(await p.locator("svg.uw-chart").count()).toBe(4);
      expect(await p.locator("[style]").count()).toBe(0);
      // CSS actually applied under the nonce'd stylesheet (not just absent violations)
      const fill = await p.locator("rect.uw-ch-s0").first().evaluate((e) => getComputedStyle(e).fill);
      expect(fill).not.toBe("rgb(0, 0, 0)");
      await p.context().close();
    }, 30_000);
  }
  it("table toggle (client-side state in a static page is inert) does not violate CSP when clicked", async () => {
    const { p, violations } = await open();
    await p.locator("button[aria-pressed]").click();
    expect(violations).toEqual([]);
    await p.context().close();
  }, 30_000);
});

describe("real-browser a11y and rendering", () => {
  it("Tab order follows DOM: toggle button, then each chart svg once", async () => {
    const { p } = await open();
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      await p.keyboard.press("Tab");
      seen.push(await p.evaluate(() => { const a = document.activeElement!; return a.tagName.toLowerCase() === "svg" ? `svg:${a.querySelector("title")?.textContent}` : a.tagName.toLowerCase(); }));
    }
    expect(seen.slice(0, 5)).toEqual(["button", "svg:ترتيب", "svg:حالات", "svg:تقادم", "svg:توقع"]);
    await p.context().close();
  }, 30_000);
  it("focused svg has a visible focus indicator (outline or similar)", async () => {
    const { p } = await open();
    await p.keyboard.press("Tab");
    await p.keyboard.press("Tab");
    const o = await p.evaluate(() => { const s = getComputedStyle(document.activeElement!); return { w: s.outlineWidth, st: s.outlineStyle, sh: s.boxShadow }; });
    expect(o.st !== "none" && o.w !== "0px" || o.sh !== "none").toBe(true);
    await p.context().close();
  }, 30_000);
  it("accessibility tree exposes each chart as an image with its name", async () => {
    const { p } = await open();
    for (const n of ["ترتيب", "حالات", "تقادم", "توقع"]) await p.getByRole("img", { name: n }).waitFor({ timeout: 2000 });
    await p.context().close();
  }, 30_000);
  it("rendered Eastern Arabic digits survive to the DOM text", async () => {
    const { p } = await open();
    const t = await p.locator("svg").first().innerText().catch(() => "");
    const txt = await p.evaluate(() => [...document.querySelectorAll("svg text")].map((e) => e.textContent).join(" "));
    expect(txt).toContain("١٬٢٣٤");
    expect(txt).not.toMatch(/[0-9]/);
    void t;
    await p.context().close();
  }, 30_000);
  it("document is RTL and the mirrored bar starts at the right edge", async () => {
    const a = await open({ mirror: true });
    expect(await a.p.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe("rtl");
    const r = await a.p.evaluate(() => {
      const svg = document.querySelector("svg")!.getBoundingClientRect();
      const bar = document.querySelector("svg rect.uw-ch-s0")!.getBoundingClientRect();
      return { svgRight: svg.right, barRight: bar.right };
    });
    expect(Math.abs(r.svgRight - r.barRight)).toBeLessThanOrEqual(2);
    await a.p.context().close();
  }, 30_000);
  it("no horizontal overflow at 320px width", async () => {
    const { p } = await open();
    await p.setViewportSize({ width: 320, height: 700 });
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(0);
    await p.context().close();
  }, 30_000);
  for (const dark of [false, true]) {
    it(`resolved series colours meet 3:1 against the resolved page background (${dark ? "dark" : "light"}, via tokensCss, not hard-coded)`, async () => {
      const { p } = await open({ dark });
      const c = await p.evaluate(() => {
        const rgb = (s: string): string => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(s)!; return "#" + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, "0")).join(""); };
        const bg = rgb(getComputedStyle(document.body).backgroundColor);
        return {
          bg,
          s0: rgb(getComputedStyle(document.querySelector("rect.uw-ch-s0")!).fill),
          axis: rgb(getComputedStyle(document.querySelector("line.uw-ch-axis")!).stroke),
          late: rgb(getComputedStyle(document.querySelector(".uw-ch-late")!).stroke),
          text: rgb(getComputedStyle(document.querySelector("text.uw-ch-text")!).fill),
          muted: rgb(getComputedStyle(document.querySelector("text.uw-ch-muted")!).fill),
        };
      });
      expect(contrast(c.s0, c.bg), JSON.stringify(c)).toBeGreaterThanOrEqual(3);
      expect(contrast(c.axis, c.bg)).toBeGreaterThanOrEqual(3);
      expect(contrast(c.late, c.bg)).toBeGreaterThanOrEqual(3);
      expect(contrast(c.text, c.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.muted, c.bg)).toBeGreaterThanOrEqual(4.5);
      await p.context().close();
    }, 30_000);
  }
  it("reduced motion: no running animations or transitions on chart elements", async () => {
    const { p } = await open({ reduced: true });
    expect(await p.evaluate(() => document.getAnimations().length)).toBe(0);
    await p.context().close();
  }, 30_000);
});
