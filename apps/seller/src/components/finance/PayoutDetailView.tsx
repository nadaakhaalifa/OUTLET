import Link from "next/link";
import { createTranslator, formatDate, formatMoney, type Locale } from "@outlet/i18n";
import { toMoney, type PayoutDetail } from "../../lib/finance-model";
import { PayoutStatusChip } from "./PayoutStatusChip";

export function PayoutDetailView({ locale, base, payout }: { locale: Locale; base: string; payout: PayoutDetail }) {
  const t = createTranslator(locale);
  const day = (iso: string) => formatDate(new Date(`${iso}T12:00:00Z`), locale, { style: "medium" });
  const m = (a: Parameters<typeof toMoney>[0]) => formatMoney(toMoney(a), locale);
  return (
    <>
      <dl className="facts">
        <div className="factRow"><dt>{t("seller.finance.payouts.col.status")}</dt><dd><PayoutStatusChip t={t} status={payout.status} /></dd></div>
        <div className="factRow"><dt>{t("seller.finance.payout.cycle")}</dt><dd>{payout.cycle_start === payout.cycle_end ? day(payout.cycle_start) : `${day(payout.cycle_start)} - ${day(payout.cycle_end)}`}</dd></div>
        <div className="factRow"><dt>{t("seller.finance.payouts.col.gross")}</dt><dd>{m(payout.gross)}</dd></div>
        <div className="factRow"><dt>{t("seller.finance.payouts.col.adjustments")}</dt><dd>{m(payout.adjustments)}</dd></div>
        <div className="factRow"><dt>{t("seller.finance.payouts.col.net")}</dt><dd><strong>{m(payout.net)}</strong></dd></div>
        <div className="factRow"><dt>{t("seller.finance.payouts.col.sent")}</dt><dd>{payout.sent_at === null ? t("seller.finance.payouts.notSent") : formatDate(new Date(payout.sent_at), locale, { style: "medium" })}</dd></div>
        {payout.settled_at === null ? null : <div className="factRow"><dt>{t("seller.finance.payout.settled")}</dt><dd>{formatDate(new Date(payout.settled_at), locale, { style: "medium" })}</dd></div>}
      </dl>
      <h2 className="panelTitle">{t("seller.finance.payout.linesTitle")}</h2>
      <table className="table">
        <caption className="srOnly">{t("seller.finance.payout.linesCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("seller.finance.payout.col.kind")}</th>
            <th scope="col">{t("seller.finance.payout.col.order")}</th>
            <th scope="col">{t("seller.finance.payout.col.amount")}</th>
          </tr>
        </thead>
        <tbody>
          {payout.lines.map((l, i) => (
            <tr key={`${l.seller_order_id ?? "adj"}-${String(i)}`}>
              <th scope="row">{t(l.kind === "order" ? "seller.finance.payout.kind.order" : "seller.finance.payout.kind.adjustment")}</th>
              <td>{l.seller_order_id === null ? "-" : <Link href={`${base}/orders/${l.seller_order_id}`} dir="ltr">{l.seller_order_id.slice(0, 8)}</Link>}</td>
              <td>{m(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {payout.lines_truncated ? <p className="hint">{t("seller.finance.payout.truncated")}</p> : null}
      <p><Link className="btnLink" href={`${base}/finance/payouts`}>{t("seller.finance.payouts.back")}</Link></p>
    </>
  );
}
