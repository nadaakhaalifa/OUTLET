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

import DisputesRoute from "../src/app/[segment]/(console)/disputes/page";
import PayoutsRoute from "../src/app/[segment]/(console)/payouts/page";
import RefundsRoute from "../src/app/[segment]/(console)/refunds/page";
import ReturnsRoute from "../src/app/[segment]/(console)/returns/page";
import { OpsList, summaryLines } from "../src/components/lists/OpsList";
import { visibleGroups } from "../src/components/shell/navigation";
import { canHold, canRelease, parseFilter, toneOf } from "../src/lib/lists";
import { planProxy } from "../src/server/bff";
import { profileFromSession, serializeProfile, visibleSections } from "../src/server/session";

afterEach(cleanup);
const ID = "11111111-1111-4111-8111-111111111111";
const fetchMock = vi.fn();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const setProfile = (roles: string[]) => { jar.set("admin_profile", serializeProfile(profileFromSession({ staff_id: ID, market_id: "eg", roles, amr: ["hwk"], expires_at: "2099-01-01T00:00:00Z" }))); jar.set("admin_session", "tok"); };
beforeEach(() => { jar.clear(); refresh.mockReset(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); vi.stubEnv("API_URL", "http://api.test/"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const clean = async (): Promise<string[]> => (await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ""}`);
const renderServer = async (el: ReactElement) => render(await (el.type as (p: unknown) => Promise<ReactElement>)(el.props));
const sp = (o: Record<string, string> = {}) => Promise.resolve(o);
const seg = (s = "eg-en") => Promise.resolve({ segment: s });

const egp = (n: string) => ({ amount_minor: n, currency: "EGP" });
const refund = (i: number, status = "REQUESTED", overdue = false) => ({
  id: `fa000000-0000-4000-8000-${String(i).padStart(12, "0")}`, order_group_id: `0a000000-0000-4000-8000-${String(i).padStart(12, "0")}`, seller_order_id: `0b000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  return_request_id: null, store_id: `5e000000-0000-4000-8000-${String(i).padStart(12, "0")}`, status, reason: "return", route: "psp_original", amount: egp("12500"), attempts: 0, overdue,
  due_at: "2026-11-09T10:00:00Z", created_at: "2026-11-08T10:00:00Z", completed_at: null,
});
const refundPage = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next, summary: [{ status: "FAILED", count: 3, amount: egp("120000") }, { status: "REQUESTED", count: 8, amount: egp("450000") }], overdue_count: 2 });
const payout = (status: string, hold: string | null = null, n = 1) => ({
  id: `9a000000-0000-4000-8000-${String(n).padStart(12, "0")}`, store_id: `5e000000-0000-4000-8000-${String(n).padStart(12, "0")}`, status, mode: "transfer", cycle_start: "2026-11-02", cycle_end: "2026-11-08",
  net: egp("240000"), hold_reason: hold, failure_code: null, created_at: "2026-11-09T10:00:00Z",
});

describe("pages", () => {
  it("refunds: loads the first keyset page (limit 20) with the status filter, shows chips with words, overdue, money and the market-wide summary", async () => {
    setProfile(["finance"]);
    fetchMock.mockResolvedValueOnce(json(200, refundPage([refund(1, "FAILED", true), refund(2)], "Y3Vy")));
    await renderServer(await RefundsRoute({ params: seg(), searchParams: sp({ status: "FAILED" }) }));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://api.test/v1/eg/admin/refunds?limit=20&status=FAILED");
    expect(screen.getByRole("heading", { level: 1, name: "Refunds" })).toBeTruthy();
    expect(document.querySelectorAll("tbody tr")).toHaveLength(2);
    const chips = [...document.querySelectorAll(".statusChip")].map((c) => c.textContent);
    expect(chips).toEqual(expect.arrayContaining(["Failed", "Overdue", "Requested"]));
    expect(screen.getByTestId("list-summary").textContent).toContain("Failed: 3");
    expect(document.body.textContent).toContain("EGP");
    expect(screen.getByTestId("load-more")).toBeTruthy();
    expect(document.querySelector('[data-filter="FAILED"]')?.getAttribute("aria-current")).toBe("true");
    expect(await clean()).toEqual([]);
  });

  it("an unknown filter value is ignored (never sent to the API); a failed load shows the banner, never a table", async () => {
    setProfile(["finance"]);
    fetchMock.mockResolvedValueOnce(json(503, { code: "admin-unavailable" }));
    await renderServer(await RefundsRoute({ params: seg(), searchParams: sp({ status: "DROP TABLE" }) }));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://api.test/v1/eg/admin/refunds?limit=20");
    expect(document.querySelector("table")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("a role without the action sees the 403 banner and no data is requested for display", async () => {
    setProfile(["support"]);
    fetchMock.mockResolvedValue(json(403, { code: "forbidden" }));
    await renderServer(await RefundsRoute({ params: seg(), searchParams: sp() }));
    expect(document.querySelector("table")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("returns (stage filter), disputes and payouts load their own endpoints", async () => {
    setProfile(["finance", "ops", "trust_safety"]);
    fetchMock.mockResolvedValueOnce(json(200, { items: [{ id: "7e000000-0000-4000-8000-000000000001", order_group_id: "0a000000-0000-4000-8000-000000000001", store_id: "5e", status: "RECEIVED", stage: "inspection_overdue", reason_code: "too_small", resolution: "refund", created_at: "2026-11-08T10:00:00Z", received_at: "2026-11-08T12:00:00Z", inspection_due_at: "2026-11-09T12:00:00Z" }], next_cursor: null, summary: { requested: 1, in_transit: 2, awaiting_inspection: 3, inspection_overdue: 1 } }));
    await renderServer(await ReturnsRoute({ params: seg(), searchParams: sp({ stage: "inspection_overdue" }) }));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://api.test/v1/eg/admin/returns?limit=20&stage=inspection_overdue");
    expect(screen.getAllByText("Inspection overdue").length).toBeGreaterThan(0);
    expect(screen.getByText("Too small")).toBeTruthy();
    cleanup();
    fetchMock.mockResolvedValueOnce(json(200, { items: [{ id: "d5000000-0000-4000-8000-000000000001", return_request_id: "7e000000-0000-4000-8000-000000000001", store_id: "5e", status: "OPEN", reason_code: "item_not_as_described", assigned: false, sla_due_at: "2026-11-08T10:00:00Z", past_sla: true, created_at: "2026-11-05T10:00:00Z", resolved_at: null }], next_cursor: null, summary: { open: 1, past_sla: 1 } }));
    await renderServer(await DisputesRoute({ params: seg(), searchParams: sp() }));
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://api.test/v1/eg/admin/disputes?limit=20");
    expect(screen.getByText("Past review deadline")).toBeTruthy();
    cleanup();
    fetchMock.mockResolvedValueOnce(json(200, { items: [payout("ON_HOLD", "ops:risk_review")], next_cursor: null, summary: [{ status: "ON_HOLD", count: 1, net: egp("240000") }] }));
    await renderServer(await PayoutsRoute({ params: seg(), searchParams: sp({ status: "ON_HOLD" }) }));
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe("http://api.test/v1/eg/admin/payouts?limit=20&status=ON_HOLD");
    expect(within(screen.getByTestId("ops-list")).getByText("Risk review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request release" })).toBeTruthy();
  });

  it("payout actions are hidden from a reader without payout.hold", async () => {
    setProfile(["ops"]);
    fetchMock.mockResolvedValueOnce(json(200, { items: [payout("SCHEDULED")], next_cursor: null, summary: [] }));
    await renderServer(await PayoutsRoute({ params: seg(), searchParams: sp() }));
    expect(screen.queryByRole("button", { name: "Hold" })).toBeNull();
  });
});

describe.each<Locale>(["ar-EG", "en-EG"])("OpsList (%s)", (locale) => {
  const t = createTranslator(locale);
  const list = (kind: "refunds" | "payouts", items: unknown[], opts: { next?: string | null; canWrite?: boolean; filter?: string; summary?: unknown } = {}) =>
    render(<OpsList kind={kind} locale={locale} market="eg" base="/eg-en" initial={{ items: items as never, next_cursor: opts.next ?? null }} summary={opts.summary ?? []} filter={opts.filter} canWrite={opts.canWrite ?? false} />);

  it("Load more asks the BFF for the next keyset page with the API's cursor and the same filter, appends the rows, then says it is the end", async () => {
    fetchMock.mockResolvedValueOnce(json(200, refundPage([refund(3), refund(4)])));
    list("refunds", [refund(1), refund(2)], { next: "Y3Vyc29y", filter: "REQUESTED" });
    expect(document.querySelectorAll("tbody tr")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("load-more"));
    await waitFor(() => { expect(document.querySelectorAll("tbody tr")).toHaveLength(4); });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string }];
    expect(url).toBe("/api/admin/eg/refunds?limit=20&cursor=Y3Vyc29y&status=REQUESTED");
    expect(init.method).toBe("GET");
    expect(screen.queryByTestId("load-more")).toBeNull();
    expect(screen.getByTestId("list-end")).toBeTruthy();
  });

  it("a failed or malformed next page keeps the rows, shows an alert and leaves the button for a retry", async () => {
    fetchMock.mockResolvedValueOnce(json(503, { code: "api-unavailable" })).mockResolvedValueOnce(json(200, { nope: true }));
    list("refunds", [refund(1)], { next: "abc" });
    fireEvent.click(screen.getByTestId("load-more"));
    await waitFor(() => { expect(screen.getByTestId("list-msg")).toBeTruthy(); });
    expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(screen.getByTestId("load-more")).toBeTruthy();
    fireEvent.click(screen.getByTestId("load-more"));
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2); });
    await waitFor(() => { expect(screen.getByTestId("list-msg").getAttribute("role")).toBe("alert"); });
    expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("an empty list says so (no stand-in rows)", () => {
    list("refunds", []);
    expect(screen.getByText(t("admin.list.empty"))).toBeTruthy();
    expect(document.querySelector("table")).toBeNull();
  });

  it("Hold posts the fixed reason with a UUIDv7 key and shows the payout as on hold; hold is offered only for SCHEDULED and APPROVED", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...payout("SCHEDULED", null, 1), status: "ON_HOLD", hold_reason: "ops:risk_review" }));
    list("payouts", [payout("SCHEDULED", null, 1), payout("SETTLED", null, 2)], { canWrite: true });
    expect(screen.getAllByRole("button", { name: t("admin.payouts.hold") })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: t("admin.payouts.hold") }));
    await waitFor(() => { expect(screen.getByTestId("list-msg").textContent).toBe(t("admin.payouts.held")); });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe("/api/admin/eg/payouts/9a000000-0000-4000-8000-000000000001/hold");
    expect(init.method).toBe("POST");
    expect(init.headers["idempotency-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(JSON.parse(init.body)).toEqual({ reason_code: "risk_review" });
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: t("admin.payouts.hold") })).toBeNull();
    expect(screen.getByRole("button", { name: t("admin.payouts.release") })).toBeTruthy();
  });

  it("Request release is filed for a second approver: the page says so and the payout stays on hold (never 'released')", async () => {
    fetchMock.mockResolvedValueOnce(json(409, { code: "dual-approval-required", detail: "req-1" }));
    list("payouts", [payout("ON_HOLD", "iban_name_mismatch")], { canWrite: true });
    expect(screen.getByText(t("admin.payouts.holdCode.iban_name_mismatch"))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t("admin.payouts.releaseReasonLabel")), { target: { value: "error_corrected" } });
    fireEvent.click(screen.getByRole("button", { name: t("admin.payouts.release") }));
    await waitFor(() => { expect(screen.getByTestId("list-msg").textContent).toBe(t("admin.payouts.releaseFiled")); });
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body)).toEqual({ reason_code: "error_corrected" });
    expect(screen.getByRole("button", { name: t("admin.payouts.release") })).toBeTruthy();
    expect(screen.getByTestId("list-msg").getAttribute("role")).toBe("status");
  });

  it("a payout that moved meanwhile (409 invalid-transition) and other failures show an alert", async () => {
    fetchMock.mockResolvedValueOnce(json(409, { code: "invalid-transition" })).mockResolvedValueOnce(json(403, { code: "forbidden" }));
    list("payouts", [payout("SCHEDULED")], { canWrite: true });
    fireEvent.click(screen.getByRole("button", { name: t("admin.payouts.hold") }));
    await waitFor(() => { expect(screen.getByTestId("list-msg").textContent).toBe(t("admin.payouts.invalid")); });
    fireEvent.click(screen.getByRole("button", { name: t("admin.payouts.hold") }));
    await waitFor(() => { expect(screen.getByTestId("list-msg").textContent).not.toBe(t("admin.payouts.invalid")); });
    expect(screen.getByTestId("list-msg").getAttribute("role")).toBe("alert");
  });

  it("no actions at all without canWrite, and the table passes the accessibility checks", async () => {
    list("payouts", [payout("SCHEDULED"), payout("ON_HOLD", "ops:kyc_review", 2)]);
    expect(screen.queryByRole("button")).toBeNull();
    expect(within(screen.getByTestId("ops-list")).getByText(t("admin.payouts.holdCode.kyc_review"))).toBeTruthy();
    expect(await clean()).toEqual([]);
  });
});

describe("pure helpers", () => {
  it("filters, tones and action gates", () => {
    expect(parseFilter("refunds", "FAILED")).toBe("FAILED");
    expect(parseFilter("refunds", "nope")).toBeUndefined();
    expect(parseFilter("returns", "in_transit")).toBe("in_transit");
    expect(parseFilter("disputes", undefined)).toBeUndefined();
    expect(toneOf("FAILED")).toBe("bad");
    expect(toneOf("COMPLETED")).toBe("ok");
    expect(toneOf("unknown-status")).toBe("info");
    expect(canHold("SCHEDULED") && canHold("APPROVED") && !canHold("SENT") && !canHold("ON_HOLD")).toBe(true);
    expect(canRelease("ON_HOLD") && !canRelease("SCHEDULED")).toBe(true);
  });

  it("summaryLines covers array, returns and disputes shapes and tolerates nothing", () => {
    const t = createTranslator("en-EG");
    expect(summaryLines("refunds", t, "en-EG", [{ status: "FAILED", count: 3, amount: egp("1000") }])[0]).toContain("Failed: 3");
    expect(summaryLines("payouts", t, "en-EG", [{ status: "ON_HOLD", count: 1, net: egp("1000") }])[0]).toContain("On hold: 1");
    expect(summaryLines("returns", t, "en-EG", { requested: 1, in_transit: 2, awaiting_inspection: 3, inspection_overdue: 4 })).toHaveLength(4);
    expect(summaryLines("disputes", t, "en-EG", { open: 5, past_sla: 2 })).toHaveLength(2);
    expect(summaryLines("disputes", t, "en-EG", null)).toEqual([]);
  });
});

describe("navigation, sections and BFF", () => {
  const prof = (roles: string[]) => profileFromSession({ staff_id: ID, market_id: "eg", roles, amr: ["hwk"], expires_at: "2099-01-01T00:00:00Z" });
  it("each section follows its policy action: finance sees refunds and payouts, ops returns, trust_safety disputes, support only returns", () => {
    expect(visibleSections(prof(["finance"]))).toEqual(expect.arrayContaining(["refunds", "payouts"]));
    expect(visibleSections(prof(["finance"]))).not.toEqual(expect.arrayContaining(["returns", "disputes"]));
    expect(visibleSections(prof(["ops"]))).toEqual(expect.arrayContaining(["returns"]));
    expect(visibleSections(prof(["ops"]))).not.toEqual(expect.arrayContaining(["refunds", "payouts", "disputes"]));
    expect(visibleSections(prof(["trust_safety"]))).toEqual(expect.arrayContaining(["returns", "disputes"]));
    expect(visibleSections(prof(["support"]))).toEqual(expect.arrayContaining(["returns"]));
    expect(visibleSections(prof(["marketing"])).filter((s) => ["refunds", "payouts", "returns", "disputes"].includes(s))).toEqual([]);
  });

  it("the nav groups put refunds and payouts under Money, returns and disputes under Orders and returns", () => {
    const groups = visibleGroups(["refunds", "payouts", "returns", "disputes", "recon"]);
    expect(groups.find((g) => g.id === "money")?.items.map((i) => i.path)).toEqual(["/refunds", "/payouts", "/reconciliation"]);
    expect(groups.find((g) => g.id === "orders")?.items.map((i) => i.path)).toEqual(["/returns", "/disputes"]);
    expect(visibleGroups(["kyc"]).find((g) => g.id === "orders")).toBeUndefined();
  });

  const plan = (method: string, path: string, search = "") => planProxy({ method, segments: ["eg", ...path.split("/")], search, headers: new Headers({ "sec-fetch-site": "same-origin", host: "x" }), cookies: { get: () => ({ value: "tok" }) }, body: null, apiUrl: "http://api.test" });
  it("the BFF allows the list reads and the two payout writes, nothing else on those paths", () => {
    for (const p of ["refunds", "payouts", "returns", "disputes", `payouts/${ID}`]) expect(plan("GET", p, "?limit=20").kind, p).toBe("forward");
    for (const a of ["hold", "release"]) expect(plan("POST", `payouts/${ID}/${a}`).kind).toBe("forward");
    expect(plan("POST", "refunds")).toMatchObject({ kind: "reject", status: 405 });
    expect(plan("DELETE", `payouts/${ID}`)).toMatchObject({ kind: "reject", status: 405 });
    expect(plan("POST", `payouts/${ID}/approve`)).toMatchObject({ kind: "reject", status: 404 });
    expect(plan("GET", "payouts/not-an-id")).toMatchObject({ kind: "reject", status: 404 });
  });
});

describe("Home links to the full lists", () => {
  it("tiles for refunds, payouts, returns and disputes link to their pages, and the refunds card's full list is /refunds", async () => {
    const { DESCRIBERS } = await import("../src/components/home/tileModel");
    const { cardBySlug } = await import("../src/lib/dashboard");
    const c = { t: createTranslator("en-EG"), locale: "en-EG" as Locale };
    expect(DESCRIBERS.refunds_waiting?.({ count: 0, amount: egp("0"), manual_review: 0, failed: 0, oldest_at: null }, c).href).toBe("/refunds");
    expect(DESCRIBERS.refunds_overdue?.({ count: 0, amount: egp("0"), oldest_due_at: null }, c).href).toBe("/refunds");
    expect(DESCRIBERS.payouts?.({ due_count: 0, due_net: egp("0"), on_hold_count: 0, on_hold_net: egp("0"), failed: 0, open_holds: 0 }, c).href).toBe("/payouts");
    expect(DESCRIBERS.returns_pipeline?.({ requested: 0, in_transit: 0, awaiting_inspection: 0, inspection_overdue: 0 }, c).href).toBe("/returns");
    expect(DESCRIBERS.disputes_open?.({ open: 0, past_sla: 0, oldest_at: null }, c).href).toBe("/disputes");
    expect(cardBySlug("refunds-waiting")?.fullList).toBe("/refunds");
  });
});
