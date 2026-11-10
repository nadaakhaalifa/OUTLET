import { createTranslator, formatMoney, type Locale } from "@outlet/i18n";
import { isZero, toMoney, type Statement } from "../../lib/finance-model";

/** A monthly read model: every row is a sum of ledger postings or of the stored order commission figures. Signs follow the balance (refunds and payouts reduce it). */
export function StatementView({ locale, statement }: { locale: Locale; statement: Statement }) {
  const t = createTranslator(locale);
  const m = (a: Parameters<typeof toMoney>[0]) => formatMoney(toMoney(a), locale);
  const quiet = [statement.opening_balance, statement.closing_balance, statement.orders_net, statement.refunds, statement.adjustments, statement.payouts].every(isZero) && statement.orders_count === 0;
  const rows: readonly { key: string; label: string; value: string; strong?: boolean; sub?: boolean }[] = [
    { key: "opening", label: t("seller.finance.statements.row.opening"), value: m(statement.opening_balance) },
    { key: "orders", label: t("seller.finance.statements.row.orders", { n: statement.orders_count }), value: m(statement.orders_gross) },
    { key: "commission", label: t("seller.finance.statements.row.commission"), value: m(toNeg(statement.commission)), sub: true },
    { key: "commissionVat", label: t("seller.finance.statements.row.commissionVat"), value: m(toNeg(statement.commission_vat)), sub: true },
    { key: "ordersNet", label: t("seller.finance.statements.row.ordersNet"), value: m(statement.orders_net) },
    { key: "refunds", label: t("seller.finance.statements.row.refunds"), value: m(statement.refunds) },
    { key: "adjustments", label: t("seller.finance.statements.row.adjustments"), value: m(statement.adjustments) },
    { key: "payouts", label: t("seller.finance.statements.row.payouts"), value: m(statement.payouts) },
    { key: "change", label: t("seller.finance.statements.row.change"), value: m(statement.net_change) },
    { key: "closing", label: t("seller.finance.statements.row.closing"), value: m(statement.closing_balance), strong: true },
  ];
  return (
    <>
      {quiet ? <p className="empty">{t("seller.finance.statements.empty")}</p> : null}
      <table className="table" data-testid="statement">
        <caption className="srOnly">{t("seller.finance.statements.caption", { month: statement.month })}</caption>
        <thead>
          <tr>
            <th scope="col">{t("seller.finance.statements.col.item")}</th>
            <th scope="col">{t("seller.finance.statements.col.amount")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-row={r.key} {...(r.sub === true ? { "data-sub": "true" } : {})}>
              <th scope="row">{r.sub === true ? <span className="subItem">{r.label}</span> : r.label}</th>
              <td>{r.strong === true ? <strong>{r.value}</strong> : r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 className="panelTitle">{t("seller.finance.statements.eta.title")}</h2>
      <p className="hint" data-testid="eta">{t("seller.finance.statements.eta.notConnected")}</p>
      <p className="hint">{t("seller.finance.statements.live")}</p>
    </>
  );
}

const toNeg = (a: Statement["commission"]): Statement["commission"] => ({ ...a, amount_minor: (-BigInt(a.amount_minor)).toString() });
