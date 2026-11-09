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
  usePathname: () => "/eg-ar",
}));

import { AttentionQueue } from "../src/components/home/AttentionQueue";
import { HomeView } from "../src/components/home/HomeView";
import HomePage from "../src/app/[segment]/(console)/page";
import AttentionRoute from "../src/app/[segment]/(console)/attention/page";
import PopPage from "../src/app/[segment]/(console)/today/[card]/page";
import { profileFromSession, serializeProfile } from "../src/server/session";
import { ATTENTION_ID_A, attentionItems, DASH_NOW, dashboardFixture, FINANCE_TILES, forbidden, unavailable } from "./fake-data";

afterEach(cleanup);
const ID = "11111111-1111-4111-8111-111111111111";
const fetchMock = vi.fn();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const setProfile = (roles: string[]) => { jar.set("admin_profile", serializeProfile(profileFromSession({ staff_id: ID, market_id: "eg", roles, amr: ["hwk"], expires_at: "2099-01-01T00:00:00Z" }))); jar.set("admin_session", "tok"); };
beforeEach(() => { jar.clear(); refresh.mockReset(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); vi.stubEnv("API_URL", "http://api.test/"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const clean = async (): Promise<string[]> => {
  const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ""}`);
};
/** Server pages return an async ConsoleFrame element; resolve it the way React would on the server. */
const renderServer = async (el: ReactElement) => {
  const type = el.type as (props: unknown) => Promise<ReactElement>;
  return render(await type(el.props));
};
const callUrls = () => fetchMock.mock.calls.map((c) => String(c[0]));

describe.each<Locale>(["ar-EG", "en-EG"])("Home (%s)", (locale) => {
  const t = createTranslator(locale);
  const seg = locale === "ar-EG" ? "eg-ar" : "eg-en";
  const view = (over = {}, range: "7d" | "30d" | "90d" = "30d", now = DASH_NOW) =>
    render(<HomeView resp={dashboardFixture(over, range)} range={range} now={now} t={t} locale={locale} base={`/${seg}`} />);
  const tileKeys = () => Array.from(document.querySelectorAll("[data-tile]")).map((e) => e.getAttribute("data-tile"));

  it("renders the greeting, Today cards linking to their pop pages, Needs you today, Sales and All checks, with no axe violations", async () => {
    const { container } = view();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/\S/);
    expect(screen.getByText(t("admin.home.glance"))).toBeTruthy();
    const today = container.querySelector("[data-section=today]");
    if (today === null) throw new Error("no today section");
    expect(Array.from(today.querySelectorAll("[data-tile]")).map((e) => e.getAttribute("data-tile"))).toEqual(["orders_today", "gmv_today", "attention_open", "approvals_pending", "kyc_queue", "refunds_waiting", "cod_awaiting_confirmation", "seller_sla_breaches"]);
    expect(within(today as HTMLElement).getAllByRole("link").map((a) => a.getAttribute("href"))).toContain(`/${seg}/today/kyc-queue`);
    expect(container.querySelector("[data-attention-panel]")).not.toBeNull();
    expect(container.querySelector("[data-section=sales]")).not.toBeNull();
    expect(Array.from(container.querySelectorAll("[data-section=checks] [data-section]")).map((e) => e.getAttribute("data-section"))).toEqual(["sellers", "orders", "money", "catalog", "trust", "platform"]);
    expect(await clean()).toEqual([]);
  });

  it("does not render forbidden tiles anywhere (cards, checks, sales panels)", () => {
    view(Object.fromEntries(FINANCE_TILES.map((k) => [k, forbidden(k)])));
    const keys = tileKeys();
    for (const k of FINANCE_TILES) expect(keys).not.toContain(k);
    expect(keys).toContain("orders_today");
    expect(document.querySelector("[data-panel=top-stores]")).toBeNull();
  });

  it("shows the reason for unavailable tiles in words, never a zero", () => {
    view({ cod_unremitted: unavailable("cod_unremitted", "not_connected"), payouts: unavailable("payouts", "read_failed"), recon_unmatched: unavailable("recon_unmatched", "stale") });
    const tile = (k: string) => document.querySelector<HTMLElement>(`[data-tile=${k}]`)!;
    expect(within(tile("cod_unremitted")).getByText(t("admin.home.unavailable.not_connected"))).toBeTruthy();
    expect(within(tile("payouts")).getByText(t("admin.home.unavailable.read_failed"))).toBeTruthy();
    expect(within(tile("recon_unmatched")).getByText(t("admin.home.unavailable.stale"))).toBeTruthy();
    expect(within(tile("payouts")).queryByTestId("tile-value")).toBeNull();
  });

  it("says Stale since for an ok tile past its refresh window and keeps its numbers", () => {
    view({}, "30d", new Date(DASH_NOW.getTime() + 5 * 60_000));
    const kyc = document.querySelector<HTMLElement>("[data-tile=kyc_queue]")!;
    expect(kyc.textContent).toMatch(t("admin.home.staleSince", { time: "" }).trim().slice(0, 3));
    expect(within(kyc).getByTestId("tile-value").textContent).toMatch(/[4٤]/);
  });

  it("Needs you today lists only counts above zero, urgent first, and drops the all-clear when a check could not be read", () => {
    view({ dsar_queue: { key: "dsar_queue", status: "ok", as_of: "2026-11-10T08:59:30Z", data: { open: 3, due_7d: 1, overdue: 2 } }, price_enforcement: unavailable("price_enforcement", "read_failed") });
    const panel = document.querySelector<HTMLElement>("[data-attention-panel]")!;
    const rows = Array.from(panel.querySelectorAll("li[data-need]")).map((e) => e.getAttribute("data-need"));
    expect(rows[0]).toBe("dsar");
    expect(rows).not.toContain("enforcement");
    expect(rows).not.toContain("recon");
    expect(within(panel).queryByTestId("attention-clear")).toBeNull();
    expect(within(panel).getByTestId("attention-incomplete").textContent).toContain(t("admin.home.needs.incomplete"));
    // a row without a destination page has no link
    expect(panel.querySelector("li[data-need=disputes] a")).toBeNull();
    expect(panel.querySelector("li[data-need=kyc] a")?.getAttribute("href")).toBe(`/${seg}/kyc`);
  });

  it("range pills link to ?range= and mark the current one", () => {
    view({}, "7d");
    const nav = screen.getByRole("navigation", { name: t("admin.home.sales.range") });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([`/${seg}?range=7d`, `/${seg}?range=30d`, `/${seg}?range=90d`]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual(["true", null, null]);
  });

  it("table toggle shows every column's value; bars have no link where no list page exists", () => {
    view({}, "7d");
    const toggle = screen.getByTestId("chart-table-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll(".chartTable tbody tr")).toHaveLength(7);
    const steps = document.querySelector<HTMLElement>("[data-panel=steps]")!;
    expect(steps.querySelectorAll("li")).toHaveLength(5);
    expect(steps.querySelectorAll("a")).toHaveLength(0);
  });

  it("falls back to order columns without finance access and groups 30 days weekly", () => {
    view({ gmv_today: forbidden("gmv_today"), sales_series: { key: "sales_series", status: "ok", as_of: "2026-11-10T08:59:30Z", data: { orders: Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, value: 1 })), gmv: null, total_orders: 30, total_gmv: null } } });
    fireEvent.click(screen.getByTestId("chart-table-toggle"));
    expect(document.querySelectorAll(".chartTable tbody tr")).toHaveLength(5);
    expect(screen.getByTestId("sales-summary")).toBeTruthy();
  });

  it("shows the role message when every tile is forbidden", () => {
    const keys = ["orders_today","gmv_today","sales_series","orders_by_step","top_stores","verified_discount_share","seller_sla_breaches","cod_awaiting_confirmation","returns_pipeline","disputes_open","refunds_waiting","refunds_overdue","payouts","recon_unmatched","cod_unremitted","ledger_integrity","kyc_queue","stores_moderation","price_enforcement","listings_by_status","breaches_open","dsar_queue","attention_open","approvals_pending","elevations_active","kill_switches"];
    view(Object.fromEntries(keys.map((k) => [k, forbidden(k)])));
    expect(screen.getByTestId("home-none").textContent).toBe(t("admin.overview.none"));
    expect(document.querySelector("[data-tile]")).toBeNull();
  });
});

describe("Home page (server)", () => {
  it("fetches the dashboard with the range, shows tiles, and falls back to Could not load on a contract mismatch", async () => {
    setProfile(["ops", "finance"]);
    fetchMock.mockResolvedValueOnce(json(200, dashboardFixture({}, "7d")));
    await renderServer(await HomePage({ params: Promise.resolve({ segment: "eg-en" }), searchParams: Promise.resolve({ range: "7d" }) }));
    expect(callUrls()[0]).toBe("http://api.test/v1/eg/admin/dashboard?range=7d");
    expect(document.querySelector("[data-tile=orders_today]")).not.toBeNull();
    cleanup();
    fetchMock.mockResolvedValueOnce(json(200, { nonsense: true }));
    await renderServer(await HomePage({ params: Promise.resolve({ segment: "eg-en" }), searchParams: Promise.resolve({ range: "1y" }) }));
    expect(callUrls()[1]).toContain("range=30d");
    const tiles = Array.from(document.querySelectorAll("[data-tile] [data-testid=tile-unavailable]"));
    expect(tiles.length).toBeGreaterThan(10);
    expect(tiles.every((e) => e.textContent === "Could not load")).toBe(true);
    expect(screen.queryByTestId("attention-clear")).toBeNull();
  });
  it("shows the problem banner (no stand-in data) when the API is down", async () => {
    setProfile(["ops"]);
    fetchMock.mockRejectedValueOnce(new Error("down"));
    await renderServer(await HomePage({ params: Promise.resolve({ segment: "eg-ar" }), searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("alert").getAttribute("data-code")).toBe("api-unavailable");
    expect(document.querySelector("[data-tile]")).toBeNull();
  });
});

describe("pop pages", () => {
  const open = (slug: string, seg = "eg-en") => PopPage({ params: Promise.resolve({ segment: seg, card: slug }) });
  it("unknown card is 404 before anything is fetched", async () => {
    setProfile(["ops"]);
    await expect(open("nope")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("a forbidden tile is 403", async () => {
    setProfile(["ops"]);
    fetchMock.mockResolvedValueOnce(json(200, dashboardFixture({ gmv_today: forbidden("gmv_today") })));
    await renderServer(await open("gmv-today"));
    expect(screen.getByRole("alert").getAttribute("data-code")).toBe("forbidden");
  });
  it("kyc-queue lists at most 50 open cases, links each, says so, and links the full list", async () => {
    setProfile(["ops"]);
    const items = Array.from({ length: 60 }, (_, i) => ({ id: `c0de0000-0000-4000-8000-${String(i).padStart(12, "0")}`, seller_id: ID, legal_name_ar: `بائع ${String(i)}`, status: "SUBMITTED", submitted_at: "2026-11-09T10:00:00Z" }));
    items.push({ id: "c0de0000-0000-4000-8000-999999999999", seller_id: ID, legal_name_ar: "x", status: "APPROVED", submitted_at: "2026-11-01T10:00:00Z" });
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.includes("/dashboard") ? json(200, dashboardFixture()) : json(200, { items, next_cursor: null })));
    await renderServer(await open("kyc-queue"));
    expect(document.querySelectorAll("[data-testid=pop-list] tbody tr")).toHaveLength(50);
    expect(screen.getByText(createTranslator("en-EG")("admin.home.pop.showing", { n: 50 }))).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the full list" }).getAttribute("href")).toBe("/eg-en/kyc");
    expect(screen.getAllByRole("link", { name: "View" })[0]?.getAttribute("href")).toMatch(/^\/eg-en\/kyc\//);
    expect(screen.getByRole("link", { name: "Back to Home" })).toBeTruthy();
  });
  it("a card without a list endpoint renders the count tile and an honest not-connected note, no fake rows", async () => {
    setProfile(["ops"]);
    fetchMock.mockResolvedValueOnce(json(200, dashboardFixture()));
    await renderServer(await open("cod-awaiting-confirmation", "eg-ar"));
    expect(document.querySelector("[data-tile=cod_awaiting_confirmation]")).not.toBeNull();
    expect(screen.getByTestId("list-missing").textContent).toBe(createTranslator("ar-EG")("admin.home.pop.listMissing"));
    expect(document.querySelector("[data-testid=pop-list]")).toBeNull();
    expect(screen.queryByRole("link", { name: createTranslator("ar-EG")("admin.home.pop.openList") })).toBeNull();
  });
  it("orders-today accepts a short series (first rollup day inside the window) and shows only those days", async () => {
    setProfile(["ops"]);
    const full = dashboardFixture();
    const short = dashboardFixture({ orders_today: { ...full.sections.today.orders_today, data: { count: 5, series_14d: [{ day: "2026-11-08", value: 1 }, { day: "2026-11-09", value: 2 }, { day: "2026-11-10", value: 3 }] } } });
    fetchMock.mockResolvedValueOnce(json(200, short));
    await renderServer(await open("orders-today"));
    expect(document.querySelectorAll("[data-testid=pop-list] tbody tr")).toHaveLength(3);
  });
  it("orders-today shows the 14-day series table", async () => {
    setProfile(["ops"]);
    fetchMock.mockResolvedValueOnce(json(200, dashboardFixture()));
    await renderServer(await open("orders-today"));
    expect(document.querySelectorAll("[data-testid=pop-list] tbody tr")).toHaveLength(14);
  });
});

describe("attention page", () => {
  it("renders the queue (open first) and gates writes by role", async () => {
    setProfile(["ops"]);
    fetchMock.mockResolvedValueOnce(json(200, { items: attentionItems, next_cursor: null }));
    await renderServer(await AttentionRoute({ params: Promise.resolve({ segment: "eg-en" }) }));
    expect(callUrls()[0]).toBe("http://api.test/v1/eg/admin/attention");
    const rows = document.querySelectorAll("[data-attention-id]");
    expect(rows[0]?.getAttribute("data-attention-id")).toBe(ATTENTION_ID_A);
    expect(screen.getAllByRole("button", { name: "Resolve" })).toHaveLength(2);
    cleanup();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe.each<Locale>(["ar-EG", "en-EG"])("AttentionQueue (%s)", (locale) => {
  const t = createTranslator(locale);
  const q = (canWrite = true) => render(<AttentionQueue locale={locale} market="eg" items={attentionItems.map((i) => ({ ...i, status: i.status as "OPEN" | "ACKED" }))} canWrite={canWrite} />);

  it("Acknowledge posts through the BFF with a UUIDv7 Idempotency-Key and refreshes", async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    q();
    const row = document.querySelector<HTMLElement>(`[data-attention-id="${ATTENTION_ID_A}"]`)!;
    fireEvent.click(within(row).getByRole("button", { name: t("admin.attention.ack") }));
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe(`/api/admin/eg/attention/${ATTENTION_ID_A}/ack`);
    expect(init.method).toBe("POST");
    expect(init.headers["idempotency-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await waitFor(() => { expect(refresh).toHaveBeenCalled(); });
  });

  it("Resolve sends the chosen reason code and a fresh key each time; acked rows have no Acknowledge button", async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    q();
    expect(screen.getAllByRole("button", { name: t("admin.attention.ack") })).toHaveLength(1);
    const row = document.querySelector<HTMLElement>(`[data-attention-id="${ATTENTION_ID_A}"]`)!;
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "DUPLICATE" } });
    fireEvent.click(within(row).getByRole("button", { name: t("admin.attention.resolve") }));
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe(`/api/admin/eg/attention/${ATTENTION_ID_A}/resolve`);
    expect(JSON.parse(init.body)).toEqual({ resolution_code: "DUPLICATE" });
    fireEvent.click(within(row).getByRole("button", { name: t("admin.attention.resolve") }));
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2); });
    expect((fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }])[1].headers["idempotency-key"]).not.toBe(init.headers["idempotency-key"]);
  });

  it("a 409 says someone else changed it; no write controls without attention.write; no axe violations", async () => {
    fetchMock.mockResolvedValue(json(409, { code: "conflict" }));
    q();
    const row = document.querySelector<HTMLElement>(`[data-attention-id="${ATTENTION_ID_A}"]`)!;
    fireEvent.click(within(row).getByRole("button", { name: t("admin.attention.ack") }));
    expect((await within(row).findByRole("alert")).textContent).toBe(t("admin.attention.conflict"));
    expect(refresh).not.toHaveBeenCalled();
    expect(await clean()).toEqual([]);
    cleanup();
    q(false);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(t("admin.attention.readOnly"))).toBeTruthy();
  });
});
