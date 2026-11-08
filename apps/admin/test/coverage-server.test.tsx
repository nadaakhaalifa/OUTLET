import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTranslator } from "@outlet/i18n";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: (n: string) => (jar.has(n) ? { value: jar.get(n) } : undefined) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { adminGet, currentProfile } from "../src/server/admin-get";
import { load } from "../src/lib/load";
import { requireLocale } from "../src/lib/segment-page";
import { alternateLinks, parseSegment } from "../src/lib/segment";
import { ConsoleFrame } from "../src/components/ConsoleFrame";
import { LogoutButton } from "../src/components/LogoutButton";
import { AuditView } from "../src/components/AuditView";
import { KycQueue } from "../src/components/KycQueue";
import { RoleBadge, TopBarActions } from "../src/components/Shell";
import { profileFromSession, serializeProfile } from "../src/server/session";

const ID = "c0de0000-0000-4000-8000-000000000001";
const prof = (roles: string[], expires = "2099-01-01T00:00:00Z") => profileFromSession({ staff_id: ID, market_id: "eg", roles, amr: ["hwk"], expires_at: expires });
const setProfile = (roles: string[]) => { jar.set("admin_profile", serializeProfile(prof(roles))); };
const fetchMock = vi.fn();
const reply = (status: number, body: string) => new Response(body, { status });

beforeEach(() => { jar.clear(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); vi.stubEnv("API_URL", "http://api.test/"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("currentProfile", () => {
  it("is null without a cookie or when it is expired, and parsed when live", async () => {
    expect(await currentProfile()).toBeNull();
    jar.set("admin_profile", serializeProfile(prof(["ops"], "2000-01-01T00:00:00Z")));
    expect(await currentProfile()).toBeNull();
    setProfile(["ops"]);
    expect((await currentProfile())?.roles).toEqual(["ops"]);
  });
});

describe("adminGet", () => {
  it("fails closed: 503 without API_URL, 401 without or with an empty token", async () => {
    vi.stubEnv("API_URL", "");
    expect(await adminGet("eg", "audit")).toEqual({ ok: false, status: 503, code: "api-unconfigured" });
    vi.stubEnv("API_URL", "http://api.test/");
    expect(await adminGet("eg", "audit")).toEqual({ ok: false, status: 401, code: "unauthenticated" });
    jar.set("admin_session", "");
    expect(await adminGet("eg", "audit")).toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("sends the bearer, trims the base URL, drops empty query values and forwards only a valid reason", async () => {
    jar.set("admin_session", "tok");
    fetchMock.mockResolvedValue(reply(200, '{"a":1}'));
    const r = await adminGet("eg", "audit", { action: "x", from: "", to: undefined }, "support_case:ABC-1");
    expect(r).toEqual({ ok: true, data: { a: 1 } });
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("http://api.test/v1/eg/admin/audit?action=x");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(init.headers["x-reason-code"]).toBe("support_case:ABC-1");
    await adminGet("eg", "audit", {}, "BAD REASON!");
    const [url2, init2] = fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(url2).toBe("http://api.test/v1/eg/admin/audit");
    expect(init2.headers["x-reason-code"]).toBeUndefined();
  });
  it("maps API problems (json code, non-string code, non-JSON) and network failure without throwing", async () => {
    jar.set("admin_session", "tok");
    fetchMock.mockResolvedValueOnce(reply(403, '{"code":"forbidden"}'));
    expect(await adminGet("eg", "p")).toEqual({ ok: false, status: 403, code: "forbidden" });
    fetchMock.mockResolvedValueOnce(reply(500, '{"code":7}'));
    expect(await adminGet("eg", "p")).toEqual({ ok: false, status: 500, code: "unknown" });
    fetchMock.mockResolvedValueOnce(reply(502, "<html>"));
    expect(await adminGet("eg", "p")).toEqual({ ok: false, status: 502, code: "unknown" });
    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect(await adminGet("eg", "p")).toEqual({ ok: false, status: 503, code: "api-unavailable" });
  });
});

describe("load", () => {
  const schema = z.object({ n: z.number() });
  it("returns validated data, passes API errors through and reports a contract mismatch as 502", async () => {
    jar.set("admin_session", "tok");
    fetchMock.mockResolvedValueOnce(reply(200, '{"n":3,"extra":1}'));
    expect(await load(schema, "eg", "x")).toEqual({ ok: true, data: { n: 3 } });
    fetchMock.mockResolvedValueOnce(reply(200, '{"n":"3"}'));
    expect(await load(schema, "eg", "x")).toEqual({ ok: false, status: 502, code: "bad-response" });
    fetchMock.mockResolvedValueOnce(reply(404, '{"code":"not-found"}'));
    expect(await load(schema, "eg", "x")).toEqual({ ok: false, status: 404, code: "not-found" });
  });
});

describe("segment helpers", () => {
  it("parses valid segments, rejects bad ones and builds canonical/hreflang links", async () => {
    expect(parseSegment("eg-ar")?.locale).toBe("ar-EG");
    expect(parseSegment("zz-ar")).toBeNull();
    expect(parseSegment("eg")).toBeNull();
    await expect(requireLocale(Promise.resolve({ segment: "nope" }))).rejects.toThrow("NEXT_NOT_FOUND");
    const en = await requireLocale(Promise.resolve({ segment: "eg-en" }));
    const links = alternateLinks(en, "/audit");
    expect(links.canonical).toBe("/eg-en/audit");
    expect(links.languages["x-default"]).toBe("/eg-ar/audit");
    expect(Object.values(links.languages)).toContain("/eg-en/audit");
  });
});

describe("ConsoleFrame", () => {
  const resolved = (s: string) => parseSegment(s)!;
  it("redirects to the locale login when there is no profile", async () => {
    await expect(ConsoleFrame({ resolved: resolved("eg-en"), section: "kyc", children: <p>secret</p> })).rejects.toThrow("REDIRECT:/eg-en/login");
  });
  it("renders children for an allowed section and the overview, without a break-glass banner", async () => {
    setProfile(["ops"]);
    const { unmount } = render(await ConsoleFrame({ resolved: resolved("eg-en"), section: "kyc", children: <p>kyc body</p> }));
    expect(screen.getByText("kyc body")).toBeTruthy();
    expect(screen.queryByTestId("break-glass")).toBeNull();
    unmount();
    render(await ConsoleFrame({ resolved: resolved("eg-ar"), section: "overview", children: <p>home</p> }));
    expect(screen.getByText("home")).toBeTruthy();
  });
  it("shows a 403 banner instead of children when the roles do not allow the section (both locales), plus break-glass for super_admin", async () => {
    setProfile(["support"]);
    for (const seg of ["eg-en", "eg-ar"]) {
      const { unmount } = render(await ConsoleFrame({ resolved: resolved(seg), section: "audit", children: <p>audit rows</p> }));
      expect(screen.queryByText("audit rows")).toBeNull();
      expect(screen.getByRole("alert").getAttribute("data-code")).toBe("forbidden");
      unmount();
    }
    setProfile(["super_admin"]);
    render(await ConsoleFrame({ resolved: resolved("eg-en"), section: "overview", children: <p>x</p> }));
    expect(screen.getByTestId("break-glass")).toBeTruthy();
  });
});

describe("LogoutButton", () => {
  const assign = vi.fn();
  beforeEach(() => {
    assign.mockReset();
    fetchMock.mockResolvedValue(reply(200, "{}"));
    Object.defineProperty(window, "location", { configurable: true, value: { assign } });
  });
  it.each([["en", "/eg-en/login"], ["ar", "/eg-ar/login"], ["fr", "/eg-ar/login"]])("posts the logout, disables while busy and goes to the %s login", async (lang, dest) => {
    document.documentElement.lang = lang;
    render(<LogoutButton locale={lang === "en" ? "en-EG" : "ar-EG"} market="eg" />);
    const btn = screen.getByRole("button", { name: createTranslator(lang === "en" ? "en-EG" : "ar-EG")("admin.topbar.logout") });
    fireEvent.click(btn);
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => { expect(assign).toHaveBeenCalledWith(dest); });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/eg/auth/logout");
    expect((fetchMock.mock.calls[0]?.[1] as { method: string }).method).toBe("POST");
  });
});

describe("Shell and tables", () => {
  const t = createTranslator("en-EG");
  it("RoleBadge shows the no-role badge when no known role survives and TopBarActions includes logout", () => {
    render(<TopBarActions t={t} locale="en-EG" market="eg" profile={prof(["bogus"])} />);
    expect(screen.getByText(t("admin.topbar.noRole"))).toBeTruthy();
    expect(screen.getByRole("button", { name: t("admin.topbar.logout") })).toBeTruthy();
  });
  it("RoleBadge lists every live role", () => {
    render(<RoleBadge t={t} profile={prof(["ops", "dpo"])} />);
    expect(document.querySelectorAll("[data-role]")).toHaveLength(2);
  });
  it("AuditView shows actor ids, 'system' and blank reasons, and the empty state", () => {
    const filters = { actor_id: "", action: "", target_type: "", from: "", to: "" };
    const base = { id: "e1", action: "kyc.approve", target_type: "kyc", target_id: ID, request_id: "r1", occurred_at: "2026-11-01T10:00:00Z" };
    const entries = [
      { ...base, actor_id: ID, reason_code: "support_case" },
      { ...base, id: "e2", actor_id: null, reason_code: null },
    ] as never;
    const { unmount } = render(<AuditView t={t} locale="en-EG" market="eg" entries={entries} filters={filters} />);
    expect(screen.getByText(ID.slice(0, 8))).toBeTruthy();
    expect(screen.getByText(t("admin.audit.system"))).toBeTruthy();
    expect(screen.getByText("support_case")).toBeTruthy();
    unmount();
    render(<AuditView t={t} locale="en-EG" market="eg" entries={[]} filters={filters} />);
    expect(screen.getByText(t("admin.audit.empty"))).toBeTruthy();
  });
  it("KycQueue shows 'not submitted' for a null submitted_at and a formatted date otherwise", () => {
    const items = [
      { id: "a", seller_id: ID, legal_name_ar: "أ", status: "DRAFT", submitted_at: null },
      { id: "b", seller_id: ID, legal_name_ar: "ب", status: "SUBMITTED", submitted_at: "2026-11-01T10:00:00Z" },
    ] as never;
    render(<KycQueue t={t} locale="en-EG" base="/eg-en" status="DRAFT" items={items} />);
    expect(screen.getByText(t("admin.kyc.notSubmitted"))).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByRole<HTMLSelectElement>("combobox").value).toBe("DRAFT");
  });
});
