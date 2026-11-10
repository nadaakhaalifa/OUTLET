import Link from "next/link";
import { createTranslator, formatDate, formatMoney, type Locale } from "@outlet/i18n";
import { isZero, toMoney, type Balance } from "../../lib/finance-model";

/** Pending and available come straight from the ledger projection; payout totals are payouts by state. Nothing here is estimated. */
export function BalanceOverview({ locale, base, balance }: { locale: Locale; base: string; balance: Balance }) {
  const t = createTranslator(locale);
  const m = (a: Parameters<typeof toMoney>[0]) => formatMoney(toMoney(a), locale);
  const p = balance.payouts;
  const nothing = [balance.pending, balance.available, p.scheduled, p.held, p.in_transit, p.paid_to_date].every(isZero);
  return (
    <>
      <section className="stats" aria-label={t("seller.finance.balance.title")}>
        <div className="stat">
          <h2 className="statLabel">{t("seller.finance.balance.available")}</h2>
          <p className="statValue" data-testid="available">{m(balance.available)}</p>
          <p className="hint">{t("seller.finance.balance.availableHelp")}</p>
        </div>
        <div className="stat">
          <h2 className="statLabel">{t("seller.finance.balance.pending")}</h2>
          <p className="statValue" data-testid="pending">{m(balance.pending)}</p>
          <p className="hint">{t("seller.finance.balance.pendingHelp")}</p>
        </div>
        <div className="stat">
          <h2 className="statLabel">{t("seller.finance.balance.total")}</h2>
          <p className="statValue" data-testid="total">{m(balance.total)}</p>
        </div>
      </section>
      {nothing ? <p className="empty">{t("seller.finance.balance.empty")}</p> : null}
      <h2 className="panelTitle">{t("seller.finance.balance.payoutsTitle")}</h2>
      <dl className="facts">
        <div className="factRow"><dt>{t("seller.finance.balance.scheduled")}</dt><dd>{m(p.scheduled)}</dd></div>
        <div className="factRow"><dt>{t("seller.finance.balance.held")}</dt><dd>{m(p.held)}</dd></div>
        <div className="factRow"><dt>{t("seller.finance.balance.inTransit")}</dt><dd>{m(p.in_transit)}</dd></div>
        <div className="factRow"><dt>{t("seller.finance.balance.paid")}</dt><dd>{m(p.paid_to_date)}</dd></div>
      </dl>
      <p className="hint">{t("seller.finance.balance.payoutsNote")}</p>
      <p className="hint">{t("seller.finance.balance.asOf", { time: formatDate(new Date(balance.server_time), locale, { style: "medium" }) })}</p>
      <p>
        <Link className="btnLink" href={`${base}/finance/payouts`}>{t("seller.finance.balance.seePayouts")}</Link>
      </p>
    </>
  );
}
