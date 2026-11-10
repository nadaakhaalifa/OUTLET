import { expect, test, type Page } from "@playwright/test";
import { t } from "./t";

const CASE = "c0de0000-0000-4000-8000-000000000001";
const control = (body: object) => fetch("http://localhost:3301/__control", { method: "POST", body: JSON.stringify(body) });
const apiLog = async (): Promise<{ path: string; reason: string | null; body?: unknown }[]> => (await fetch("http://localhost:3301/__log")).json() as Promise<{ path: string; reason: string | null; body?: unknown }[]>;

/** The virtual authenticator needs a registered credential; the mock API accepts any assertion, so the browser ceremony is stubbed. */
const stubPasskey = (page: Page) =>
  page.addInitScript(() => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { get: () => Promise.resolve({ id: "e2e", rawId: buf, type: "public-key", response: { clientDataJSON: buf, authenticatorData: buf, signature: buf, userHandle: null } }) },
    });
  });

const signIn = async (page: Page) => {
  await stubPasskey(page);
  await page.goto("/eg-ar/login");
  await page.getByRole("button", { name: t("admin.login.passkey") }).click();
  // Home opens with a time-of-day greeting as its h1, so wait for the console (any level-1 heading, off the login route).
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
};

test.beforeEach(async () => {
  await control({ roles: ["ops", "finance", "dpo", "security"] });
});

test("strict nonce CSP, RTL, and the console redirects to passkey login when signed out", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/content security policy/i.test(m.text())) violations.push(m.text());
  });
  const res = await page.goto("/eg-ar/kyc");
  expect(page.url()).toContain("/eg-ar/login");
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).not.toContain("unsafe-inline");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("button", { name: t("admin.login.totp") })).toBeDisabled();
  expect(violations).toEqual([]);
});

test("passkey login, then KYC: a document needs a reason code, and approval is recorded with one", async ({ page }) => {
  await signIn(page);
  await expect(page.getByText(t("admin.role.ops"))).toBeVisible();
  await expect(page.getByTestId("break-glass")).toHaveCount(0);

  await page.getByRole("link", { name: t("admin.nav.kyc") }).click();
  await page.getByRole("link", { name: new RegExp(t("admin.kyc.open")) }).click();
  await expect(page.getByRole("heading", { level: 1, name: t("admin.kyc.case.title") })).toBeVisible();

  // Opening a document: the dialog blocks until a reason code is chosen, and no request is made before that.
  const before = (await apiLog()).length;
  await page.getByRole("button", { name: t("admin.kyc.doc.open") }).click();
  await page.getByRole("button", { name: t("admin.action.confirm") }).click();
  await expect(page.getByRole("alert").filter({ hasText: t("admin.reason.choose") })).toBeVisible();
  expect((await apiLog()).length).toBe(before);

  await page.getByLabel(t("admin.reason.code")).selectOption("support_ticket");
  await page.getByLabel(t("admin.reason.ticket")).fill("T-42");
  await page.getByRole("button", { name: t("admin.action.confirm") }).click();
  await expect(page.getByRole("link", { name: t("admin.kyc.doc.openLink") })).toHaveAttribute("href", /signed\/commercial-register\.pdf/);
  const opened = (await apiLog()).find((l) => l.path.endsWith("/documents/d0c00000-0000-4000-8000-000000000001/url"));
  expect(opened?.reason).toBe("support_ticket:T-42");

  // Approve with a reason code.
  await page.getByLabel(t("admin.kyc.decision.note")).fill("ok");
  await page.getByRole("button", { name: t("admin.kyc.decision.submit") }).click();
  await expect(page.getByRole("status").filter({ hasText: t("admin.kyc.decision.done") })).toBeVisible();
  const decision = (await apiLog()).find((l) => l.path === "/kyc-decision");
  expect(decision?.body).toEqual({ decision: "APPROVED", decision_reason: "docs_valid: ok" });

  // The reveal landed in the audit log with its reason code.
  await page.goto("/eg-ar/audit");
  await expect(page.getByText("kyc.document.open")).toBeVisible();
  await expect(page.getByRole("cell", { name: "support_ticket:T-42" })).toBeVisible();
  await page.getByRole("button", { name: t("admin.audit.verify.run") }).click();
  await expect(page.getByTestId("chain-status")).toHaveText(t("admin.audit.verify.ok"));
});

test("the document URL is refused without a reason code (API contract)", async ({ page }) => {
  await signIn(page);
  const res = await page.request.get(`/api/admin/eg/kyc-cases/${CASE}/documents/d0c00000-0000-4000-8000-000000000001/url`);
  expect(res.status()).toBe(400);
  expect(((await res.json()) as { code: string }).code).toBe("reason-code-required");
  const bad = await page.request.get(`/api/admin/eg/kyc-cases/${CASE}/documents/d0c00000-0000-4000-8000-000000000001/url`, { headers: { "x-reason-code": "no good" } });
  expect(bad.status()).toBe(422);
});

test("reconciliation list shows escalation for items older than three days and honest integrity states", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: t("admin.nav.recon") }).click();
  await expect(page.getByTestId("trial-balance")).toHaveText(t("admin.recon.integrity.notRun"));
  await page.getByRole("link", { name: new RegExp(t("admin.recon.run.items")) }).click();
  await expect(page.locator('tr[data-aging="escalated"]')).toHaveCount(1);
  await expect(page.locator('tr[data-aging="ok"]')).toHaveCount(1);
  await expect(page.getByText(t("admin.recon.age.escalated"))).toBeVisible();
  await page.locator("tr[data-aging='escalated'] summary").click();
  await page.locator("tr[data-aging='escalated']").getByLabel(t("admin.recon.resolve.ticket")).fill("FIN-7");
  await page.locator("tr[data-aging='escalated']").getByLabel(t("admin.recon.resolve.note")).fill("ok");
  await page.locator("tr[data-aging='escalated']").getByRole("button", { name: t("admin.recon.resolve.submit") }).click();
  await expect(page.locator('tr[data-aging="escalated"]')).toHaveCount(0);
});

test("role-limited navigation, break-glass banner, DPO timers and the non-submitting incident stub", async ({ page }) => {
  await control({ roles: ["dpo", "super_admin"] });
  await signIn(page);
  await expect(page.getByTestId("break-glass")).toBeVisible();
  await expect(page.getByRole("link", { name: t("admin.nav.audit") })).toBeVisible();
  await expect(page.getByRole("link", { name: t("admin.nav.recon") })).toHaveCount(0);
  await page.getByRole("link", { name: t("admin.nav.dpo") }).click();
  await expect(page.locator('tr[data-overdue="true"]')).toHaveCount(1);
  await expect(page.getByText(t("admin.dpo.breach.empty"))).toBeVisible();
  const submit = page.getByRole("button", { name: t("admin.dpo.breach.form.submit") });
  await expect(submit).toHaveAttribute("aria-disabled", "true");
  const before = (await apiLog()).length;
  await submit.click({ force: true });
  expect((await apiLog()).length).toBe(before);
});

test("a role without the section sees a forbidden banner, not data", async ({ page }) => {
  await control({ roles: ["marketing"] });
  await signIn(page);
  await expect(page.getByRole("link", { name: t("admin.nav.kyc") })).toHaveCount(0);
  await page.goto("/eg-ar/kyc");
  await expect(page.locator("[role=alert][data-code=forbidden]")).toHaveText(t("admin.error.forbidden"));
});

test("a short orders series and an untracked dispatch figure render instead of Could not load", async ({ page }) => {
  await control({ roles: ["ops"] });
  await signIn(page);
  await expect(page.locator("[data-tile=orders_today]")).toBeVisible();
  await expect(page.locator("[data-tile=orders_today] svg rect")).toHaveCount(3);
  await expect(page.locator("[data-tile=seller_sla_breaches]").first()).toContainText(t("admin.home.note.slaNoDispatch", { accept: "٢" }));
});
