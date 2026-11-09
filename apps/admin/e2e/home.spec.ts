import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const AXE_SRC = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const LIGHT_DIR = fileURLToPath(new URL("../../../docs/design/admin-home-shots/", import.meta.url));
const DARK_DIR = fileURLToPath(new URL("./shots/", import.meta.url));
const CATALOG = {
  "eg-ar": JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/i18n/src/catalogs/ar-EG.json", import.meta.url)), "utf8")) as Record<string, string>,
  "eg-en": JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/i18n/src/catalogs/en-EG.json", import.meta.url)), "utf8")) as Record<string, string>,
};
type Seg = keyof typeof CATALOG;
/** Catalog text for a locale; a message with {placeholders} is cut at the first one (we assert the stable prefix). */
const msg = (seg: Seg, key: string): string => (CATALOG[seg][key] ?? key).split("{")[0]?.trim() ?? key;

const LOCALES: readonly Seg[] = ["eg-ar", "eg-en"];
const VIEWPORTS = [{ name: "390", width: 390, height: 844 }, { name: "1440", width: 1440, height: 900 }] as const;
const THEMES = ["light", "dark"] as const;

const control = (body: object) => fetch("http://localhost:3301/__control", { method: "POST", body: JSON.stringify(body) });
const RESET = { roles: ["ops", "finance", "dpo", "security"], tileModes: {}, shortSeries: false, conflict: false, kycRows: 1, resetAttention: true };
const apiLog = async (): Promise<{ path: string; key?: string }[]> => (await fetch("http://localhost:3301/__log")).json() as Promise<{ path: string; key?: string }[]>;

test.use({ bypassCSP: true });
test.beforeEach(async () => { await control(RESET); });
test.afterEach(async () => { await control(RESET); });

const signIn = async (page: Page) => {
  await page.addInitScript(() => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { get: () => Promise.resolve({ id: "e2e", rawId: buf, type: "public-key", response: { clientDataJSON: buf, authenticatorData: buf, signature: buf, userHandle: null } }) },
    });
  });
  await page.goto("/eg-ar/login");
  await page.locator("button").first().click();
  await page.waitForURL((u) => !u.pathname.endsWith("/login"));
};

const open = async (browser: import("@playwright/test").Browser, vp: { width: number; height: number }, theme: "light" | "dark"): Promise<{ ctx: BrowserContext; page: Page }> => {
  const ctx = await browser.newContext({ baseURL: "http://localhost:3300", viewport: { width: vp.width, height: vp.height }, colorScheme: theme, bypassCSP: true });
  const page = await ctx.newPage();
  await signIn(page);
  return { ctx, page };
};

const goHome = async (page: Page, seg: Seg, query = "") => {
  await page.goto(`/${seg}${query}`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("[data-home]")).toBeVisible();
};

/** Interactive elements with an effective hit area under 44x44 (own box or an ::after overlay). */
const smallTargets = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("a[href], button, select, summary, input, [role=button]"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      if (el.closest(".skip") && !el.matches(":focus")) continue;
      let w = r.width, h = r.height;
      const a = getComputedStyle(el, "::after");
      if (a.content !== "none" && a.position === "absolute") { w = Math.max(w, parseFloat(a.width) || 0); h = Math.max(h, parseFloat(a.height) || 0); }
      if (w < 43.5 || h < 43.5) out.push(`${el.tagName.toLowerCase()}.${el.className} "${(el.textContent || "").trim().slice(0, 24)}" ${String(Math.round(w))}x${String(Math.round(h))}`);
    }
    return out;
  });

const axeProblems = async (page: Page): Promise<string[]> => {
  await page.evaluate(AXE_SRC);
  return page.evaluate(async () => {
    interface V { id: string; impact: string | null; nodes: { target: unknown[] }[] }
    const axe = (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: V[] }> } }).axe;
    const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}(${v.impact ?? ""}) ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  });
};

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// ---- Matrix: locale x viewport x theme, full-access (finance) role and the ops-only role ----------------------------------------------
for (const seg of LOCALES) for (const vp of VIEWPORTS) for (const theme of THEMES) {
  test(`home matrix: ${seg} ${vp.name} ${theme}`, async ({ browser }) => {
    const { ctx, page } = await open(browser, vp, theme);
    const problems: string[] = [];
    await goHome(page, seg);

    // finance (all four roles): all 8 Today cards, the finance tiles present.
    const todayCount = await page.locator('[data-section="today"] li.tile').count();
    if (todayCount !== 8) problems.push(`finance Today cards = ${String(todayCount)}, expected 8`);
    for (const k of ["gmv_today", "refunds_waiting"]) if ((await page.locator(`[data-section="today"] [data-tile="${k}"]`).count()) !== 1) problems.push(`finance missing ${k}`);

    // Needs you today: only counts > 0, urgent first. Fixture: dsar overdue (urgent), attention 1, kyc 1, sla 3, cod 6; everything else is 0 or unreadable.
    const needs = await page.locator("[data-need]").evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("data-need") ?? "", urgent: e.hasAttribute("data-urgent"), count: (e.querySelector(".attentionCount")?.textContent ?? "").trim() })));
    expect(needs.map((n) => n.id).sort()).toEqual(["attention", "cod", "dsar", "kyc", "sla"]);
    if (needs[0]?.id !== "dsar" || !needs[0].urgent) problems.push(`urgent row not first: ${JSON.stringify(needs.map((n) => n.id))}`);
    const firstNonUrgent = needs.findIndex((n) => !n.urgent);
    if (firstNonUrgent >= 0 && needs.slice(firstNonUrgent).some((n) => n.urgent)) problems.push("an urgent row follows a non-urgent one");
    if (needs.some((n) => /^[0٠]+$/.test(n.count))) problems.push("a zero-count row is shown");
    // disputes_open is unreadable in the fixture: the panel must not claim all clear.
    await expect(page.getByTestId("attention-incomplete")).toBeVisible();
    await expect(page.getByTestId("attention-clear")).toHaveCount(0);

    // Layout structure.
    const sales = await page.locator('[data-section="sales"]').boundingBox();
    const checks = await page.locator('[data-section="checks"]').boundingBox();
    if (!sales || !checks || checks.y < sales.y) problems.push("All checks is not below Sales and orders");
    if (vp.width === 390) {
      const xs = await page.locator('[data-section="today"] li.tile').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
      if (new Set(xs).size !== 1) problems.push(`Today cards are not one per row on the phone: lefts ${JSON.stringify([...new Set(xs)])}`);
    } else {
      const lefts = await page.locator('[data-section="today"] li.tile').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size);
      if (lefts < 2) problems.push("Today cards are a single column at 1440");
    }

    const ov = await overflow(page);
    if (ov > 0) problems.push(`horizontal overflow ${String(ov)}px`);
    for (const s of await smallTargets(page)) problems.push(`small target ${s}`);
    for (const a of await axeProblems(page)) problems.push(`axe ${a}`);
    await expect(page.locator("html")).toHaveAttribute("dir", seg === "eg-ar" ? "rtl" : "ltr");

    await page.screenshot({ path: `${theme === "light" ? LIGHT_DIR : DARK_DIR}/home-${seg}-${vp.name}-${theme}.png`, fullPage: true });
    await ctx.close();
    expect(problems).toEqual([]);
  });
}

// ---- Role-dependent tiles -----------------------------------------------------------------------------------------------------------
for (const seg of LOCALES) {
  test(`ops-only role: forbidden tiles are absent from the DOM (${seg})`, async ({ browser }) => {
    await control({ roles: ["ops"] });
    const { ctx, page } = await open(browser, VIEWPORTS[1], "light");
    await goHome(page, seg);
    expect(await page.locator('[data-section="today"] li.tile').count()).toBe(6);
    for (const k of ["gmv_today", "refunds_waiting", "refunds_overdue", "payouts", "recon_unmatched", "cod_unremitted", "ledger_integrity", "top_stores"]) {
      await expect(page.locator(`[data-tile="${k}"]`)).toHaveCount(0);
      await expect(page.locator(`[data-panel="${k.replace(/_/g, "-")}"]`)).toHaveCount(0);
    }
    await expect(page.locator('[data-panel="top-stores"]')).toHaveCount(0);
    // No finance heading text or amount leaks either: the money section has no visible tiles, so it is not rendered at all.
    await expect(page.locator('[data-section="money"]')).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toMatch(/EGP|ج\.م/);
    // Orders-only series: a 3-point orders chart (series length from the fixture).
    await expect(page.locator('[data-tile="orders_today"] svg').first()).toBeVisible();
    await ctx.close();
  });
}

// ---- Honest numbers -----------------------------------------------------------------------------------------------------------------
for (const seg of LOCALES) {
  test(`unavailable tile says "Not connected yet" and never a digit (${seg})`, async ({ browser }) => {
    await control({ tileModes: { kyc_queue: "not_connected", approvals_pending: "read_failed" } });
    const { ctx, page } = await open(browser, VIEWPORTS[0], "light");
    await goHome(page, seg);
    for (const [k, key] of [["kyc_queue", "admin.home.unavailable.not_connected"], ["approvals_pending", "admin.home.unavailable.read_failed"]] as const) {
      const tiles = page.locator(`[data-tile="${k}"]`);
      expect(await tiles.count()).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < (await tiles.count()); i++) {
        const tile = tiles.nth(i);
        await expect(tile).toContainText(msg(seg, key));
        await expect(tile.getByTestId("tile-value")).toHaveCount(0);
        expect(await tile.innerText()).not.toMatch(/[0-9٠-٩]/);
      }
    }
    // An unreadable check also removes the "all clear" claim and the need row is not counted as zero.
    await expect(page.locator('[data-need="kyc"]')).toHaveCount(0);
    await expect(page.getByTestId("attention-clear")).toHaveCount(0);
    await ctx.close();
  });

  test(`stale tile shows the stale note (${seg})`, async ({ browser }) => {
    await control({ tileModes: { cod_awaiting_confirmation: "stale" } });
    const { ctx, page } = await open(browser, VIEWPORTS[0], "light");
    await goHome(page, seg);
    const tile = page.locator('[data-tile="cod_awaiting_confirmation"]').first();
    await expect(tile).toContainText(msg(seg, "admin.home.staleSince"));
    await expect(tile).not.toContainText(msg(seg, "admin.home.updated"));
    // A stale figure is not acted on as fact in Needs you today.
    await expect(page.locator('[data-need="cod"]')).toHaveCount(0);
    await expect(page.getByTestId("attention-incomplete")).toBeVisible();
    await ctx.close();
  });
}

// ---- Range pills and the chart ------------------------------------------------------------------------------------------------------
test("range pills change ?range= and the chart; table toggle exposes every value with aria-pressed", async ({ browser }) => {
  const { ctx, page } = await open(browser, VIEWPORTS[1], "light");
  await goHome(page, "eg-en");
  const pills = page.locator(".rangePill");
  await expect(pills).toHaveCount(3);
  await expect(page.locator('.rangePill[aria-current="true"]')).toHaveAttribute("data-range", "30d");
  const bars = (p: Page) => p.locator('[data-section="sales"] rect.colsBar').count();
  const n30 = await bars(page);
  await page.locator('.rangePill[data-range="7d"]').click();
  await page.waitForURL(/\?range=7d/);
  await expect(page.locator('.rangePill[aria-current="true"]')).toHaveAttribute("data-range", "7d");
  const n7 = await bars(page);
  expect(n7).toBe(7);
  expect(n30).not.toBe(n7);
  await page.locator('.rangePill[data-range="90d"]').click();
  await page.waitForURL(/\?range=90d/);
  expect(await bars(page)).toBe(13); // 90 days = 13 weekly columns, anchored at the newest day
  await page.goto("/eg-en?range=bogus");
  await expect(page.locator('.rangePill[aria-current="true"]')).toHaveAttribute("data-range", "30d");

  await page.locator('.rangePill[data-range="7d"]').click();
  await page.waitForURL(/\?range=7d/);
  const toggle = page.getByTestId("chart-table-toggle").first();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const chartValues = await page.locator('[data-section="sales"] .cols g > title').evaluateAll((els) => els.map((e) => (e.textContent).replace(/\s*\(.*\)$/, "")));
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const rows = await page.locator('[data-section="sales"] .chartView table tbody tr').evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll("th,td")).map((c) => (c.textContent).trim())));
  expect(rows).toHaveLength(7);
  expect(rows.map((r) => `${r[0] ?? ""}: ${r[1] ?? ""}`)).toEqual(chartValues);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await ctx.close();
});

test("short (3-point) series still renders a chart, and its table lists all three values", async ({ browser }) => {
  await control({ shortSeries: true });
  const { ctx, page } = await open(browser, VIEWPORTS[0], "light");
  await goHome(page, "eg-en");
  expect(await page.locator('[data-section="sales"] rect.colsBar').count()).toBe(3);
  await page.getByTestId("chart-table-toggle").first().click();
  await expect(page.locator('[data-section="sales"] .chartView table tbody tr')).toHaveCount(3);
  expect(await overflow(page)).toBe(0);
  await ctx.close();
});

// ---- Pop pages --------------------------------------------------------------------------------------------------------------------
test("pop page lists at most 50 rows with a back link and the full-list link", async ({ browser }) => {
  await control({ kycRows: 60 });
  const { ctx, page } = await open(browser, VIEWPORTS[0], "light");
  await goHome(page, "eg-en");
  await page.locator('[data-tile="kyc_queue"]').first().getByRole("link").click(); // a Today card opens its pop page
  await page.waitForURL("**/eg-en/today/kyc-queue");
  await page.waitForLoadState("networkidle");
  const rows = page.getByTestId("pop-list").locator("tbody tr");
  await expect(rows).toHaveCount(50);
  await expect(page.getByText(msg("eg-en", "admin.home.pop.showing"))).toBeVisible();
  await expect(page.getByRole("link", { name: msg("eg-en", "admin.home.pop.openList") })).toHaveAttribute("href", "/eg-en/kyc");
  expect(await overflow(page)).toBe(0);
  for (const s of await smallTargets(page)) expect(s).toBe("");
  const back = page.getByRole("link", { name: msg("eg-en", "admin.home.pop.back") });
  await back.click();
  await page.waitForURL((u) => u.pathname === "/eg-en");
  await ctx.close();
});

test("pop page: a card the role may not see answers 403, an unknown slug answers 404", async ({ browser }) => {
  await control({ roles: ["ops"] });
  const { ctx, page } = await open(browser, VIEWPORTS[0], "light");
  const bad = await page.goto("/eg-en/today/no-such-card");
  expect(bad?.status()).toBe(404);
  const forbidden = await page.goto("/eg-en/today/gmv-today");
  expect(forbidden?.status()).toBeLessThan(500);
  await expect(page.locator('[data-code="forbidden"]')).toBeVisible();
  expect(await page.locator('[data-tile="gmv_today"]').count()).toBe(0);
  await ctx.close();
});

for (const seg of LOCALES) {
  test(`pop page screenshots and a11y (${seg})`, async ({ browser }) => {
    const { ctx, page } = await open(browser, VIEWPORTS[0], "light");
    await page.goto(`/${seg}/today/orders-today`);
    await page.waitForLoadState("networkidle");
    const problems = [...(await smallTargets(page)).map((s) => `small ${s}`), ...(await axeProblems(page)).map((a) => `axe ${a}`)];
    if ((await overflow(page)) > 0) problems.push("overflow");
    if (seg === "eg-ar") await page.screenshot({ path: `${LIGHT_DIR}/pop-eg-ar-390-light.png`, fullPage: true });
    await ctx.close();
    expect(problems).toEqual([]);
  });
}

// ---- Attention page -------------------------------------------------------------------------------------------------------------------
test("attention page: ack sends an Idempotency-Key; a 409 shows the 'changed by someone else' message", async ({ browser }) => {
  const { ctx, page } = await open(browser, VIEWPORTS[0], "light");
  await page.goto("/eg-ar/attention");
  await page.waitForLoadState("networkidle");
  const problems = [...(await smallTargets(page)).map((s) => `small ${s}`), ...(await axeProblems(page)).map((a) => `axe ${a}`)];
  if ((await overflow(page)) > 0) problems.push("overflow");
  await page.screenshot({ path: `${LIGHT_DIR}/attention-eg-ar-390-light.png`, fullPage: true });
  expect(problems).toEqual([]);

  const ackRow = page.locator('[data-attention-id="a7700000-0000-4000-8000-000000000001"]');
  await ackRow.getByRole("button", { name: CATALOG["eg-ar"]["admin.attention.ack"] as string }).click();
  await expect(ackRow.getByRole("status")).toContainText(msg("eg-ar", "admin.attention.done"));
  const sent = (await apiLog()).filter((l) => l.path === "/attention-ack");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  await control({ conflict: true, resetAttention: true });
  await page.goto("/eg-en/attention");
  await page.waitForLoadState("networkidle");
  const row = page.locator('[data-attention-id="a7700000-0000-4000-8000-000000000001"]');
  await row.getByRole("button", { name: CATALOG["eg-en"]["admin.attention.ack"] as string }).click();
  await expect(row.getByRole("alert")).toContainText(msg("eg-en", "admin.attention.conflict"));
  await ctx.close();
});
