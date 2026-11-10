import Link from "next/link";
import { createTranslator, formatDate, formatMoney, type Locale } from "@outlet/i18n";
import { toMoney, type PayoutSummary } from "../../lib/finance-model";
import { PayoutStatusChip } from "./PayoutStatusChip";

export function PayoutsTable({ locale, base, rows }: { locale: Locale; base: string; rows: readonly PayoutSummary[] }) {
  const t = createTranslator(locale);
  const day = (iso: string) => formatDate(new Date(`${iso}T12:00:00Z`), locale, { style: "medium" });
  if (rows.length === 0) return <p className="empty">{t("seller.finance.payouts.empty")}</p>;
  return (
    <table className="table">
      <caption className="srOnly">{t("seller.finance.payouts.caption")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("seller.finance.payouts.col.cycle")}</th>
          <th scope="col">{t("seller.finance.payouts.col.status")}</th>
          <th scope="col">{t("seller.finance.payouts.col.gross")}</th>
          <th scope="col">{t("seller.finance.payouts.col.adjustments")}</th>
          <th scope="col">{t("seller.finance.payouts.col.net")}</th>
          <th scope="col">{t("seller.finance.payouts.col.sent")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <th scope="row">
              <Link href={`${base}/finance/payouts/${r.id}`}>
                {r.cycle_start === r.cycle_end ? day(r.cycle_start) : `${day(r.cycle_start)} - ${day(r.cycle_end)}`}
              </Link>
            </th>
            <td><PayoutStatusChip t={t} status={r.status} /></td>
            <td>{formatMoney(toMoney(r.gross), locale)}</td>
            <td>{formatMoney(toMoney(r.adjustments), locale)}</td>
            <td>{formatMoney(toMoney(r.net), locale)}</td>
            <td>{r.sent_at === null ? t("seller.finance.payouts.notSent") : formatDate(new Date(r.sent_at), locale, { style: "medium" })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
