import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { createTranslator, formatMoney, type Locale } from "@outlet/i18n";
import { money } from "@outlet/money";
import { BalanceOverview } from "../src/components/finance/BalanceOverview";
import { PayoutDetailView } from "../src/components/finance/PayoutDetailView";
import { PayoutsTable } from "../src/components/finance/PayoutsTable";
import { StatementView } from "../src/components/finance/StatementView";
import { Sidebar } from "../src/components/Sidebar";
import { Balance, PayoutDetail, PayoutPage, Statement, cairoMonth, type PayoutSummary } from "../src/lib/finance-model";

const LOCALES: Locale[] = ["ar-EG", "en-EG"];
const clean = async (): Promise<string[]> => (await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations.map((v) => v.id);
const A = (n: number) => ({ amount_minor: String(n), currency: "EGP" as const });
const fmt = (n: number, l: Locale) => formatMoney(money(BigInt(n), "EGP"), l);
const ID = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";

const BALANCE = Balance.parse({ pending: A(200_000), available: A(256_000), total: A(456_000), server_time: "2025-04-01T10:00:00.000Z", payouts: { scheduled: A(100_000), held: A(0), in_transit: A(500_000), paid_to_date: A(900_000) } });
const PAYOUT: PayoutSummary = PayoutPage.parse({ items: [{ id: ID, status: "ON_HOLD", cycle_start: "2025-03-01", cycle_end: "2025-03-07", gross: A(550_000), adjustments: A(-50_000), net: A(500_000), created_at: "2025-03-08T10:00:00.000Z", sent_at: null, settled_at: null }], next_cursor: null }).items[0]!;
const STATEMENT = Statement.parse({
  month: "2025-03", period_start: "2025-02-28T22:00:00.000Z", period_end: "2025-03-31T21:00:00.000Z", orders_count: 3,
  opening_balance: A(200_000), closing_balance: A(456_000), orders_gross: A(1_000_000), commission: A(100_000), commission_vat: A(14_000), orders_net: A(886_000),
  refunds: A(-100_000), adjustments: A(-30_000), payouts: A(-500_000), net_change: A(256_000), eta_invoice: { status: "not_connected", url: null },
});

describe.each(LOCALES)("finance components (%s)", (locale) => {
  const t = createTranslator(locale);

  it("balance shows the ledger figures and explains pending, available and payouts, with no a11y violations", async () => {
    render(<BalanceOverview locale={locale} base="/eg-ar" balance={BALANCE} />);
    expect(screen.getByTestId("available").textContent).toBe(fmt(256_000, locale));
    expect(screen.getByTestId("pending").textContent).toBe(fmt(200_000, locale));
    expect(screen.getByTestId("total").textContent).toBe(fmt(456_000, locale));
    expect(screen.getByText(t("seller.finance.balance.payoutsNote"))).toBeTruthy();
    expect(screen.queryByText(t("seller.finance.balance.empty"))).toBeNull();
    expect(await clean()).toEqual([]);
  });

  it("an all-zero balance says so honestly instead of showing nothing", () => {
    const zero = Balance.parse({ ...BALANCE, pending: A(0), available: A(0), total: A(0), payouts: { scheduled: A(0), held: A(0), in_transit: A(0), paid_to_date: A(0) } });
    render(<BalanceOverview locale={locale} base="/eg-ar" balance={zero} />);
    expect(screen.getByText(t("seller.finance.balance.empty"))).toBeTruthy();
  });

  it("payouts table: text status chip, signed adjustment, link to the detail, not-sent note; empty state when none", async () => {
    const { unmount } = render(<PayoutsTable locale={locale} base="/eg-ar" rows={[PAYOUT]} />);
    const row = screen.getByRole("row", { name: new RegExp(t("seller.finance.payouts.status.ON_HOLD")) });
    expect(within(row).getByText(fmt(-50_000, locale))).toBeTruthy();
    expect(within(row).getByText(t("seller.finance.payouts.notSent"))).toBeTruthy();
    expect(screen.getAllByRole("link")[0]?.getAttribute("href")).toBe(`/eg-ar/finance/payouts/${ID}`);
    expect(await clean()).toEqual([]);
    unmount();
    render(<PayoutsTable locale={locale} base="/eg-ar" rows={[]} />);
    expect(screen.getByText(t("seller.finance.payouts.empty"))).toBeTruthy();
  });

  it("payout detail lists the lines, which add up to the net, and links the order", async () => {
    const detail = PayoutDetail.parse({ ...PAYOUT, status: "SETTLED", sent_at: "2025-03-09T10:00:00.000Z", settled_at: "2025-03-10T10:00:00.000Z", lines: [{ kind: "order", seller_order_id: ORDER, amount: A(550_000) }, { kind: "adjustment", seller_order_id: null, amount: A(-50_000) }], lines_truncated: true });
    render(<PayoutDetailView locale={locale} base="/eg-ar" payout={detail} />);
    expect(screen.getByRole("link", { name: ORDER.slice(0, 8) }).getAttribute("href")).toBe(`/eg-ar/orders/${ORDER}`);
    expect(screen.getByText(t("seller.finance.payout.truncated"))).toBeTruthy();
    expect(screen.getByText(t("seller.finance.payout.kind.adjustment"))).toBeTruthy();
    expect(await clean()).toEqual([]);
  });

  it("statement rows match the API figures, the ETA link is honestly not connected, and the live-view note is shown", async () => {
    render(<StatementView locale={locale} statement={STATEMENT} />);
    const row = (k: string) => screen.getByTestId("statement").querySelector(`[data-row="${k}"] td`)?.textContent;
    expect(row("opening")).toBe(fmt(200_000, locale));
    expect(row("orders")).toBe(fmt(1_000_000, locale));
    expect(row("commission")).toBe(fmt(-100_000, locale));
    expect(row("commissionVat")).toBe(fmt(-14_000, locale));
    expect(row("ordersNet")).toBe(fmt(886_000, locale));
    expect(row("refunds")).toBe(fmt(-100_000, locale));
    expect(row("payouts")).toBe(fmt(-500_000, locale));
    expect(row("closing")).toBe(fmt(456_000, locale));
    expect(screen.getByTestId("eta").textContent).toBe(t("seller.finance.statements.eta.notConnected"));
    expect(screen.getByText(t("seller.finance.statements.live"))).toBeTruthy();
    expect(screen.queryByText(t("seller.finance.statements.empty"))).toBeNull();
    expect(await clean()).toEqual([]);
  });

  it("an empty month is stated plainly", () => {
    const zero = Statement.parse({ ...STATEMENT, orders_count: 0, opening_balance: A(0), closing_balance: A(0), orders_gross: A(0), commission: A(0), commission_vat: A(0), orders_net: A(0), refunds: A(0), adjustments: A(0), payouts: A(0), net_change: A(0) });
    render(<StatementView locale={locale} statement={zero} />);
    expect(screen.getByText(t("seller.finance.statements.empty"))).toBeTruthy();
  });

  it("the sidebar links Balance, Payouts and Statements and marks the current page", () => {
    render(<Sidebar t={t} base="/eg-ar" current="payouts" />);
    expect(screen.getByRole("link", { name: t("seller.nav.finance") }).getAttribute("href")).toBe("/eg-ar/finance");
    expect(screen.getByRole("link", { name: t("seller.nav.payouts") }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: t("seller.nav.statements") }).getAttribute("href")).toBe("/eg-ar/finance/statements");
  });
});

describe("finance model", () => {
  it("cairoMonth follows the Cairo calendar, not UTC", () => {
    expect(cairoMonth(new Date("2025-03-31T22:30:00Z"))).toBe("2025-04");
    expect(cairoMonth(new Date("2025-03-31T20:30:00Z"))).toBe("2025-03");
  });
  it("rejects a non-EGP or float amount from the wire", () => {
    expect(Balance.safeParse({ ...BALANCE, pending: { amount_minor: "10.5", currency: "EGP" } }).success).toBe(false);
    expect(Balance.safeParse({ ...BALANCE, pending: { amount_minor: "10", currency: "USD" } }).success).toBe(false);
  });
});
