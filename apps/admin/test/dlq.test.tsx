import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator, type Locale } from "@outlet/i18n";

const jar = new Map<string, string>();
const refresh = vi.fn();
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: (n: string) => (jar.has(n) ? { value: jar.get(n) } : undefined) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  useRouter: () => ({ refresh, back: vi.fn() }),
  usePathname: () => "/eg-en",
}));

import DlqRoute from "../src/app/[segment]/(console)/dlq/page";
import { DlqQueue } from "../src/components/DlqQueue";
import { ageLabel, isMoneyType } from "../src/lib/dlq";
import { profileFromSession, serializeProfile } from "../src/server/session";

afterEach(cleanup);
const ID = "11111111-1111-4111-8111-111111111111";
const A = "d1900000-0000-4000-8000-000000000001";
const B = "d1900000-0000-4000-8000-000000000002";
const NOW = "2026-11-10T12:00:00Z";
const items = [
  { id: A, event_id: "e1900000-0000-4000-8000-000000000001", event_type: "order.placed", attempts: 8, last_error: "Error:E_DOWN", dead_lettered_at: "2026-11-10T07:00:00Z" },
  { id: B, event_id: "e1900000-0000-4000-8000-000000000002", event_type: "refund.attention", attempts: 8, last_error: null, dead_lettered_at: "2026-11-08T07:00:00Z" },
];
const fetchMock = vi.fn();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const setProfile = (roles: string[]) => { jar.set("admin_profile", serializeProfile(profileFromSession({ staff_id: ID, market_id: "eg", roles, amr: ["hwk"], expires_at: "2099-01-01T00:00:00Z" }))); jar.set("admin_session", "tok"); };
beforeEach(() => { jar.clear(); refresh.mockReset(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); vi.stubEnv("API_URL", "http://api.test/"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const clean = async (): Promise<string[]> => (await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ""}`);
const renderServer = async (el: ReactElement) => render(await (el.type as (p: unknown) => Promise<ReactElement>)(el.props));

describe("dlq page", () => {
  it("loads /dlq (limit 50), lists rows, and offers actions only with dlq.manage", async () => {
    setProfile(["ops"]);
    fetchMock.mockResolvedValueOnce(json(200, { items, next_cursor: null }));
    await renderServer(await DlqRoute({ params: Promise.resolve({ segment: "eg-en" }) }));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://api.test/v1/eg/admin/dlq?limit=50");
    expect(document.querySelectorAll("[data-dlq-id]")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Replay" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
    cleanup();
    setProfile(["support"]);
    fetchMock.mockResolvedValueOnce(json(200, { items, next_cursor: null }));
    await renderServer(await DlqRoute({ params: Promise.resolve({ segment: "eg-en" }) }));
    expect(screen.queryByRole("button", { name: "Replay" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("a failed load shows the problem banner instead of the table", async () => {
    setProfile(["ops"]);
    fetchMock.mockResolvedValueOnce(json(503, { code: "admin-unavailable" }));
    await renderServer(await DlqRoute({ params: Promise.resolve({ segment: "eg-en" }) }));
    expect(document.querySelector("[data-dlq-id]")).toBeNull();
  });
});

describe.each<Locale>(["ar-EG", "en-EG"])("DlqQueue (%s)", (locale) => {
  const t = createTranslator(locale);
  const q = (canManage = true, rows = items) => render(<DlqQueue locale={locale} market="eg" items={rows} now={NOW} canManage={canManage} />);
  const row = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-dlq-id="${id}"]`)!;

  it("buttons stay disabled until a row is selected; Replay posts the selected ids with a UUIDv7 key and refreshes", async () => {
    fetchMock.mockResolvedValue(json(200, { results: [{ id: A, outcome: "replayed" }], changed: 1 }));
    q();
    expect(screen.getByRole("button", { name: t("admin.dlq.replay") }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(row(A)).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: t("admin.dlq.replay") }));
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string; headers: Record<string, string> }];
    expect(url).toBe("/api/admin/eg/dlq/replay");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ ids: [A] });
    expect(init.headers["idempotency-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await waitFor(() => { expect(refresh).toHaveBeenCalled(); });
    expect((await screen.findByTestId("dlq-msg")).textContent).toBe(t("admin.dlq.done"));
  });

  it("Discard sends the chosen reason; a money type warns beforehand and a 409 dual-approval says it was filed, not done", async () => {
    fetchMock.mockResolvedValue(json(409, { code: "dual-approval-required" }));
    q();
    expect(screen.queryByTestId("dlq-money-hint")).toBeNull();
    fireEvent.click(within(row(B)).getByRole("checkbox"));
    expect(screen.getByTestId("dlq-money-hint")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "handled_manually" } });
    fireEvent.click(screen.getByRole("button", { name: t("admin.dlq.discard") }));
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/admin/eg/dlq/discard");
    expect(JSON.parse(init.body)).toEqual({ ids: [B], reason_code: "handled_manually" });
    expect((await screen.findByTestId("dlq-msg")).textContent).toBe(t("admin.dlq.needsApproval"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("not_in_dlq (changed 0) and an API error are reported, never as success", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { results: [{ id: A, outcome: "not_in_dlq" }], changed: 0 }));
    q();
    fireEvent.click(within(row(A)).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: t("admin.dlq.replay") }));
    expect((await screen.findByTestId("dlq-msg")).textContent).toBe(t("admin.dlq.nothingChanged"));
    fetchMock.mockResolvedValueOnce(json(403, { code: "forbidden" }));
    fireEvent.click(within(row(A)).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: t("admin.dlq.replay") }));
    await waitFor(() => { expect(screen.getByTestId("dlq-msg").getAttribute("role")).toBe("alert"); });
  });

  it("empty list, read-only role, and no axe violations", async () => {
    q(true, []);
    expect(screen.getByTestId("dlq-empty").textContent).toBe(t("admin.dlq.empty"));
    cleanup();
    q(false);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(t("admin.dlq.readOnly"))).toBeTruthy();
    cleanup();
    q();
    expect(await clean()).toEqual([]);
  });
});

describe("dlq helpers", () => {
  it("classifies money event types like the API", () => {
    for (const x of ["refund.attention", "promotions.settle_requested", "payout.hold_requested", "order_group.late_payment_refund"]) expect(isMoneyType(x)).toBe(true);
    expect(isMoneyType("order.placed")).toBe(false);
  });
  it("ageLabel picks minutes, hours or days and passes junk through", () => {
    const now = new Date(NOW);
    expect(ageLabel("2026-11-10T11:30:00Z", now, "en-EG")).toBe("30 minutes ago");
    expect(ageLabel("2026-11-10T07:00:00Z", now, "en-EG")).toBe("5 hours ago");
    expect(ageLabel("2026-11-08T07:00:00Z", now, "en-EG")).toBe("2 days ago");
    expect(ageLabel("junk", now, "en-EG")).toBe("junk");
  });
});
