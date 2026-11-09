import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator, type Locale } from "@outlet/i18n";

let pathname = "/eg-ar/kyc";
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ back: vi.fn(), refresh: vi.fn() }) }));

import { AdminShell } from "../src/components/shell/AdminShell";
import { MobileTabBar } from "../src/components/shell/MobileTabBar";
import { switchLocaleHref, tabItems, visibleGroups } from "../src/components/shell/navigation";
import { AttentionPanel } from "../src/components/kit/AttentionPanel";
import { ColumnsChart } from "../src/components/kit/ColumnsChart";
import { ConfirmDialog } from "../src/components/kit/ConfirmDialog";
import { EmptyState } from "../src/components/kit/EmptyState";
import { Info } from "../src/components/kit/Info";
import { KpiCard } from "../src/components/kit/KpiCard";
import { PageHeader } from "../src/components/kit/PageHeader";
import { Tile } from "../src/components/kit/Tile";
import { deltaOf, deltaText } from "../src/lib/charts/format";
import { profileFromSession, type SectionId } from "../src/server/session";

afterEach(cleanup);
const ID = "11111111-1111-4111-8111-111111111111";
const prof = (roles: string[]) => profileFromSession({ staff_id: ID, market_id: "eg", roles, amr: ["hwk"], expires_at: "2099-01-01T00:00:00Z" });
const clean = async (): Promise<string[]> => {
  const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ""}`);
};

describe.each<Locale>(["ar-EG", "en-EG"])("AdminShell (%s)", (locale) => {
  const t = createTranslator(locale);
  const seg = locale === "ar-EG" ? "eg-ar" : "eg-en";
  const shell = (sections: SectionId[], roles = ["ops"], current: "overview" | SectionId = "kyc") =>
    render(<AdminShell t={t} locale={locale} market="eg" base={`/${seg}`} profile={prof(roles)} sections={sections} current={current}><p>body</p></AdminShell>);

  it("renders the frame, filters navigation by sections, and has no axe violations", async () => {
    pathname = `/${seg}/kyc`;
    const { container } = shell(["kyc", "access"]);
    expect(container.querySelector(".adminShell")).not.toBeNull();
    const side = container.querySelector<HTMLElement>(".adminSide");
    if (side === null) throw new Error("no sidebar");
    expect(within(side).getByRole("link", { name: t("admin.nav.kyc") }).getAttribute("aria-current")).toBe("page");
    expect(within(side).getByRole("link", { name: t("admin.nav.overview") }).getAttribute("href")).toBe(`/${seg}`);
    expect(within(side).queryByRole("link", { name: t("admin.nav.recon") })).toBeNull();
    expect(within(side).queryByText(t("admin.nav.group.money"))).toBeNull();
    expect(within(side).getByText(t("admin.nav.group.sellers"))).toBeTruthy();
    expect(screen.getByRole("main").textContent).toBe("body");
    expect(await clean()).toEqual([]);
  });

  it("language switch keeps the segment routing and is named in the target language", () => {
    pathname = `/${seg}/reconciliation`;
    shell(["recon"], ["finance"], "recon");
    const other = locale === "ar-EG" ? "eg-en" : "eg-ar";
    const link = screen.getByRole("link", { name: new RegExp(t(locale === "ar-EG" ? "admin.lang.en" : "admin.lang.ar")) });
    expect(link.getAttribute("href")).toBe(`/${other}/reconciliation`);
  });

  it("shows the break-glass banner and role badge for super_admin", () => {
    shell(["kyc"], ["super_admin"]);
    expect(screen.getByTestId("break-glass")).toBeTruthy();
    expect(screen.getByText(t("admin.role.super_admin"))).toBeTruthy();
  });
});

describe("AdminShell RTL", () => {
  it("renders Arabic copy (dir is set by the layout, logical CSS does the mirroring)", () => {
    const t = createTranslator("ar-EG");
    render(<AdminShell t={t} locale="ar-EG" market="eg" base="/eg-ar" profile={prof(["ops"])} sections={["kyc"]} current="overview"><p /></AdminShell>);
    expect(screen.getAllByText(t("admin.brand")).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: t("admin.nav.overview") }).length).toBeGreaterThan(0);
  });
});

describe("mobile tab bar", () => {
  const t = createTranslator("en-EG");
  it("offers at most 4 destinations plus Menu, each a real link or button", () => {
    const groups = visibleGroups(["kyc", "recon", "price", "dpo", "audit", "access"]);
    expect(tabItems(groups).map((i) => i.id)).toEqual(["overview", "kyc", "recon", "price"]);
    render(<MobileTabBar t={t} locale="en-EG" base="/eg-en" groups={groups} current="kyc" />);
    const bar = screen.getByRole("navigation", { name: t("admin.nav.tabs") });
    expect(within(bar).getAllByRole("link")).toHaveLength(4);
    expect(within(bar).getByRole("button", { name: t("admin.nav.menu") })).toBeTruthy();
  });
  it("shows fewer tabs when the session sees fewer sections", () => {
    expect(tabItems(visibleGroups(["access"])).map((i) => i.id)).toEqual(["overview", "access"]);
  });
  it("switchLocaleHref swaps only the first segment", () => {
    expect(switchLocaleHref("/eg-ar/kyc/abc", "eg", "en-EG")).toBe("/eg-en/kyc/abc");
    expect(switchLocaleHref("/eg-ar", "eg", "en-EG")).toBe("/eg-en");
  });
});

describe.each<Locale>(["ar-EG", "en-EG"])("kit (%s)", (locale) => {
  const t = createTranslator(locale);
  const rtl = locale === "ar-EG";
  const fake = [{ label: "A", value: 100_00 }, { label: "B", value: 900_00 }, { label: "C", value: 300_00 }, { label: "D", value: 500_00 }];
  const chart = (points = fake) => (
    <ColumnsChart points={points} rtl={rtl} title="Fake fixture chart" format={{ kind: "money", locale }} axisFormat={{ kind: "moneyCompact", locale }} valueHeader="Value" labelHeader="Day" tableLabel={t("admin.kit.tableView")} emptyText={t("admin.kit.chartEmpty")} highestLabel={t("admin.kit.highest")} latestLabel={t("admin.kit.latest")} />
  );

  it("ColumnsChart toggles to a table that lists every value (aria-pressed)", async () => {
    render(chart());
    const btn = screen.getByRole("button", { name: t("admin.kit.tableView") });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(1 + fake.length);
    expect(screen.getByRole("table").textContent).toContain(rtl ? "ج.م" : "EGP");
    expect(await clean()).toEqual([]);
  });

  it("ColumnsChart labels the highest and the newest column directly, never JOD", () => {
    const { container } = render(chart());
    const caps = container.querySelectorAll(".colsCap");
    expect(caps).toHaveLength(2);
    expect(container.textContent).not.toMatch(/JOD|د\.أ/);
    expect(container.querySelectorAll("bdi").length).toBeGreaterThan(0);
  });

  it("ColumnsChart shows the empty text and renders no bars for no data", () => {
    const { container } = render(chart([]));
    expect(screen.getByText(t("admin.kit.chartEmpty"))).toBeTruthy();
    expect(container.querySelectorAll(".colsBar")).toHaveLength(0);
  });

  it("Tile shows value, status words and link; KpiCard shows an honest no-comparison", async () => {
    render(<>
      <ul><Tile tileKey="x" icon="alert" label="Fake tile" value="12" status="alert" statusLabel={t("admin.kit.statusAlert")} href="/eg-ar/kyc" linkLabel={t("admin.kit.attention.open")} /></ul>
      <KpiCard label="Fake KPI" value="5" delta={deltaOf(5, 0)} deltaText={deltaText(deltaOf(5, 0), locale)} noneLabel={t("admin.kit.noComparison")} deltaLabels={{ up: "u", down: "d", flat: "f" }} rtl={rtl} spark={[1, 3, 2]} sparkLabel="trend" sparkText={(i, v) => `${String(i)}:${String(v)}`} />
    </>);
    expect(screen.getByTestId("tile-value").textContent).toBe("12");
    expect(screen.getByText(t("admin.kit.statusAlert"))).toBeTruthy();
    expect(screen.getByRole("link", { name: /Fake tile/ }).getAttribute("href")).toBe("/eg-ar/kyc");
    expect(screen.getByText(t("admin.kit.noComparison"))).toBeTruthy();
    expect(await clean()).toEqual([]);
  });

  it("AttentionPanel lists rows with an Open link and shows an all-clear when empty", async () => {
    const { rerender } = render(<AttentionPanel title={t("admin.kit.attention.title")} allClear={t("admin.kit.attention.allClear")} openLabel={t("admin.kit.attention.open")} items={[{ key: "a", icon: "alert", title: "Fake row", hint: "Fake hint", count: "3", href: "/eg-ar/kyc" }]} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/eg-ar/kyc");
    expect(link.textContent).toContain("Fake row");
    expect(link.textContent).toContain(t("admin.kit.attention.open"));
    expect(await clean()).toEqual([]);
    rerender(<AttentionPanel title="T" allClear={t("admin.kit.attention.allClear")} openLabel="o" items={[]} />);
    expect(screen.getByTestId("attention-clear").textContent).toContain(t("admin.kit.attention.allClear"));
  });

  it("PageHeader, EmptyState, Info and ConfirmDialog render accessibly", () => {
    const onConfirm = vi.fn();
    render(<>
      <PageHeader title="Fake page" description="Plain sentence." info={<Info label={t("admin.kit.info")}>Explained.</Info>} />
      <EmptyState title="Nothing yet">Add one.</EmptyState>
      <ConfirmDialog open title="Sure?" confirmLabel="Yes" cancelLabel={t("admin.kit.dialog.cancel")} workingLabel="..." onConfirm={onConfirm} onCancel={() => undefined}>Body</ConfirmDialog>
    </>);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Fake page");
    const info = screen.getByRole("button", { name: t("admin.kit.info") });
    expect(info.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(info);
    expect(screen.getByRole("note").textContent).toBe("Explained.");
    fireEvent.click(screen.getByRole("button", { name: "Yes", hidden: true }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
