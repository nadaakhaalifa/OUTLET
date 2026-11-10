import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator, type Locale } from "@outlet/i18n";
import { AccountPanel } from "../src/components/shop/AccountPanel";
import { ApiProblem } from "../src/lib/client-api";
import { consentSchema, privacyRequestSchema } from "../src/lib/wire";
import { consent, privacyRequest, session, stubApi } from "./shop-fixtures";

afterEach(cleanup);
const EN: Locale = "en-EG";
const t = createTranslator(EN);
const api = (over = {}) => stubApi({
  me: vi.fn().mockResolvedValue({ phoneMasked: "+201••••••678" }),
  listSessions: vi.fn().mockResolvedValue([session(), session({ id: "s2", current: false, platform: "ios", ua_family: null, last_seen_at: null })]),
  listConsents: vi.fn().mockResolvedValue([consent("analytics")]),
  listPrivacyRequests: vi.fn().mockResolvedValue([]), ...over,
});

describe("AccountPanel actions that fail", () => {
  it("a refused action shows the generic action error and keeps the data; a note from an earlier success is cleared", async () => {
    const revokeSession = vi.fn().mockRejectedValue(new ApiProblem(500, "boom", null, null));
    const patchConsents = vi.fn().mockResolvedValueOnce([consent("analytics", true)]);
    render(<AccountPanel locale={EN} api={api({ revokeSession, patchConsents })} navigate={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Consent analytics"));
    await screen.findByText("Your choice was saved.");
    fireEvent.click(screen.getByRole("button", { name: /End session \(ios\)/ }));
    expect((await screen.findByRole("alert")).textContent).toBe(t("account.error.action"));
    expect(screen.queryByText("Your choice was saved.")).toBeNull();
    expect(screen.getByRole("button", { name: /End session \(ios\)/ })).toBeTruthy();
  });

  it("an expired session during an action returns to sign-in instead of a generic error", async () => {
    const requestExport = vi.fn().mockRejectedValue(new ApiProblem(401, "unauthenticated", null, null));
    render(<AccountPanel locale={EN} api={api({ requestExport })} navigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Request a copy of my data" }));
    expect((await screen.findByRole("link", { name: "Sign in" })).getAttribute("href")).toBe("/eg-en/login?next=%2Feg-en%2Faccount");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("AccountPanel labels", () => {
  it("a device never seen shows no last-seen note; a known request state is translated, an unknown one is shown as sent", async () => {
    const reqs = [
      privacyRequestSchema.parse({ id: "p1", kind: "export", status: "RECEIVED", due_at: "2026-12-01T00:00:00Z", cooling_until: null, created_at: "2026-11-08T00:00:00Z" }),
      privacyRequestSchema.parse({ id: "p2", kind: "export", status: "SOMETHING_NEW", due_at: "2026-12-01T00:00:00Z", cooling_until: null, created_at: "2026-11-08T00:00:00Z" }),
    ];
    render(<AccountPanel locale={EN} api={api({ listPrivacyRequests: vi.fn().mockResolvedValue(reqs) })} navigate={vi.fn()} />);
    await screen.findByText("Signed-in devices");
    const rows = screen.getAllByRole("listitem");
    expect(rows.some((r) => r.textContent.includes("SOMETHING_NEW"))).toBe(true);
    expect(rows.some((r) => r.textContent.includes(t("account.privacy.state.RECEIVED")))).toBe(true);
    const ios = rows.find((r) => r.textContent.includes("ios"));
    expect(ios?.textContent).not.toContain("Last used");
    const current = rows.find((r) => r.textContent.includes("Safari"));
    expect(current?.textContent).toContain("Last used");
  });

  it("consent text follows the language, and falls back to Arabic when there is no English text", async () => {
    const noEn = consentSchema.parse({ purpose_code: "analytics", purpose_version: 3, granted: false, text_ar: "موافقة عربية", text_en: null });
    const { unmount } = render(<AccountPanel locale={EN} api={api({ listConsents: vi.fn().mockResolvedValue([noEn, consent("marketing_push")]) })} navigate={vi.fn()} />);
    expect(await screen.findByText("موافقة عربية")).toBeTruthy();
    expect(screen.getByText("Consent marketing_push")).toBeTruthy();
    unmount();
    render(<AccountPanel locale="ar-EG" api={api({ listConsents: vi.fn().mockResolvedValue([consent("marketing_push")]) })} navigate={vi.fn()} />);
    await waitFor(() => { expect(screen.getByText("موافقة marketing_push")).toBeTruthy(); });
  });

  it("a cooling deletion without a date and without a block shows neither line, and can still be cancelled", async () => {
    const cancelDelete = vi.fn().mockResolvedValue(undefined);
    render(<AccountPanel locale={EN} api={api({ listPrivacyRequests: vi.fn().mockResolvedValue([privacyRequest({ cooling_until: null, blocked_reason: null })]), cancelDelete })} navigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel deletion request" }));
    await waitFor(() => { expect(cancelDelete).toHaveBeenCalledTimes(1); });
    expect(screen.queryByText(/Deletion is cooling until/)).toBeNull();
    expect(screen.queryByText(/Deletion is blocked:/)).toBeNull();
  });
});
