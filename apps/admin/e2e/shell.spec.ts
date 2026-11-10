import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const AXE_SRC = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const LIGHT_DIR = fileURLToPath(new URL("../../../docs/design/admin-shell-shots/", import.meta.url));
const OTHER_DIR = process.env.SHELL_SHOTS_DIR ?? fileURLToPath(new URL("./shots/", import.meta.url));

const LOCALES = ["eg-ar", "eg-en"] as const;
const VIEWPORTS = [{ name: "390", width: 390, height: 844 }, { name: "1440", width: 1440, height: 900 }] as const;
const THEMES = ["light", "dark"] as const;
const PAGES = ["", "/kyc", "/price-integrity", "/reconciliation", "/privacy", "/audit", "/access"] as const;

const control = (body: object) => fetch("http://localhost:3301/__control", { method: "POST", body: JSON.stringify(body) });

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

test.use({ bypassCSP: true });
test.beforeEach(async () => { await control({ roles: ["ops", "finance", "dpo", "security"] }); });

/** Visible interactive elements inside the chrome, with their effective hit size (own box or an ::after overlay). */
const smallTargets = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const sel = ".adminSide a, .adminSide summary, .topbar a, .topbar button, .tabBar a, .tabBar button, dialog[open] a, dialog[open] button";
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      let w = r.width, h = r.height;
      const a = getComputedStyle(el, "::after");
      if (a.content !== "none" && a.position === "absolute") { w = Math.max(w, parseFloat(a.width) || 0); h = Math.max(h, parseFloat(a.height) || 0); }
      if (w < 43.5 || h < 43.5) out.push(`${el.tagName.toLowerCase()}.${el.className} "${(el.textContent || "").trim().slice(0, 20)}" ${String(Math.round(w))}x${String(Math.round(h))}`);
    }
    return out;
  });

for (const locale of LOCALES) for (const vp of VIEWPORTS) for (const theme of THEMES) {
  test(`chrome: ${locale} ${vp.name} ${theme}`, async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: "http://localhost:3300", viewport: { width: vp.width, height: vp.height }, colorScheme: theme, bypassCSP: true });
    const page = await ctx.newPage();
    await signIn(page);
    const problems: string[] = [];
    for (const p of PAGES) {
      await page.goto(`/${locale}${p}`);
      await page.waitForLoadState("networkidle");
      const tag = `[${p || "/"}]`;
      const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (ov > 0) problems.push(`${tag} horizontal overflow ${String(ov)}px`);
      const sideVisible = await page.locator(".adminSide").isVisible();
      const tabVisible = await page.locator(".tabBar").isVisible();
      if (vp.width < 768 ? sideVisible || !tabVisible : !sideVisible || tabVisible) problems.push(`${tag} wrong chrome: side=${String(sideVisible)} tab=${String(tabVisible)}`);
      for (const s of await smallTargets(page)) problems.push(`${tag} small target ${s}`);
      const current = await page.locator('[aria-current="page"]:visible, .tabBar .tab[data-active]:visible').count();
      if (current < 1) problems.push(`${tag} no visible aria-current`);
      await page.evaluate(AXE_SRC);
      const res = await page.evaluate(async () => {
        interface Violation { id: string; impact: string | null; nodes: { target: unknown[] }[] }
        const axe = (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: Violation[] }> } }).axe;
        const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
        return r.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id}(${v.impact ?? ""}) ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
      });
      for (const r of res) problems.push(`${tag} axe ${r}`);
      if (p === "") await page.screenshot({ path: `${theme === "light" ? LIGHT_DIR : OTHER_DIR}/shell-${locale}-${vp.name}-${theme}.png` });
    }
    if (locale === "eg-ar") {
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      if (vp.width >= 768) {
        const box = await page.locator(".adminSide").boundingBox();
        if (!box || box.x + box.width < vp.width - 2) problems.push("RTL: sidebar not on the right edge");
      }
    } else {
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    }
    await ctx.close();
    expect(problems).toEqual([]);
  });
}

test.describe("phone drawer, language switch, skip link", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("drawer opens and closes by keyboard, traps focus, restores focus", async ({ page }) => {
    await signIn(page);
    await page.goto("/eg-en/kyc");
    const menu = page.locator(".tabBar button.tab");
    await menu.focus();
    await page.keyboard.press("Enter");
    const dlg = page.locator("dialog.drawer");
    await expect(dlg).toBeVisible();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !document.activeElement || document.activeElement === document.body || !!document.activeElement.closest("dialog.drawer"))).toBe(true); // modal: focus may leave to browser chrome (body) but never reach inert page content
    }
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => !document.activeElement || document.activeElement === document.body || !!document.activeElement.closest("dialog.drawer"))).toBe(true); // modal: focus may leave to browser chrome (body) but never reach inert page content
    }
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await expect(menu).toBeFocused();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
  });

  test("drawer link navigates and closes", async ({ page }) => {
    await signIn(page);
    await page.goto("/eg-en");
    await page.locator(".tabBar button.tab").click();
    await page.locator("dialog.drawer").getByRole("link", { name: "Audit log" }).click();
    await page.waitForURL("**/audit");
    await expect(page.locator("dialog.drawer")).toBeHidden();
  });

  test("language switch keeps the path", async ({ page }) => {
    await signIn(page);
    await page.goto("/eg-ar/price-integrity");
    await page.locator("a.langSwitch").click();
    await page.waitForURL("**/eg-en/price-integrity");
    await expect(page.locator("html")).toHaveAttribute("lang", /en/);
    await page.locator("a.langSwitch").click();
    await page.waitForURL("**/eg-ar/price-integrity");
  });
});

test("skip link is first focusable, visible on focus, moves focus to main", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/eg-en/audit");
  await page.keyboard.press("Tab");
  const skip = page.locator("a.skip");
  await expect(skip).toBeFocused();
  const box = await skip.boundingBox();
  expect(box && box.y >= 0).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#content$/);
  await expect(page.locator("#content")).toBeFocused();
});

test("sidebar aria-current marks exactly the active page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/eg-en/reconciliation");
  const cur = page.locator('.adminSide [aria-current="page"]');
  await expect(cur).toHaveCount(1);
  await expect(cur).toHaveAttribute("href", "/eg-en/reconciliation");
});
