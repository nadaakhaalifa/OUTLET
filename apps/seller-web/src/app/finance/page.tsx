import { ScreenFrame } from "../../components/ScreenFrame";
import { loadFinance } from "../../loaders";
import { pageCtx } from "../../page-context";

export default async function FinancePage() {
  const { ctx, t } = await pageCtx();
  const state = await loadFinance(ctx);
  return (
    <section aria-labelledby="fin-h">
      <h2 id="fin-h">{t("finance.title")}</h2>
      <ScreenFrame state={state} t={t}>
        {(vm) => (
          <>
            {vm.balance === null ? <p className="hint">{t("finance.balance.unavailable")}</p> : (
              <>
                <p className="hint">{t("common.asOf", { time: vm.balance.asOf })}</p>
                <dl className="tiles">
                  <div className="tile"><dt>{t("finance.available")}</dt><dd>{vm.balance.available}</dd></div>
                  <div className="tile"><dt>{t("finance.pending")}</dt><dd>{vm.balance.pending}</dd></div>
                  <div className="tile"><dt>{t("finance.held")}</dt><dd>{vm.balance.held}</dd></div>
                  {vm.balance.inTransit === null ? null : (
                    <div className="tile"><dt>{t("finance.inTransit")}</dt><dd>{vm.balance.inTransit}</dd></div>
                  )}
                  {vm.balance.negativeCarry === null ? null : (
                    <div className="tile"><dt>{t("finance.negative")}</dt><dd>{vm.balance.negativeCarry}</dd></div>
                  )}
                </dl>
              </>
            )}
            <h3>{t("finance.payouts")}</h3>
            {vm.payouts.length === 0 ? <p className="hint">{t("state.empty")}</p> : (
              <div className="tablewrap"><table>
                <caption className="vh">{t("finance.payouts")}</caption>
                <thead><tr><th scope="col">{t("finance.col.period")}</th><th scope="col">{t("finance.col.amount")}</th><th scope="col">{t("finance.col.status")}</th></tr></thead>
                <tbody>{vm.payouts.map((p) => <tr key={p.id}><th scope="row">{p.period}</th><td>{p.amount}</td><td>{t(p.statusKey)}</td></tr>)}</tbody>
              </table></div>
            )}
            <h3>{t("finance.invoices")}</h3>
            {vm.invoices.length === 0 ? <p className="hint">{t("state.empty")}</p> : (
              <div className="tablewrap"><table>
                <caption className="vh">{t("finance.invoices")}</caption>
                <thead><tr><th scope="col">{t("finance.col.period")}</th><th scope="col">{t("finance.col.amount")}</th><th scope="col">{t("finance.col.vat")}</th><th scope="col">{t("finance.col.status")}</th><th scope="col">{t("finance.col.etaUuid")}</th></tr></thead>
                <tbody>
                  {vm.invoices.map((i) => (
                    <tr key={i.id}><th scope="row">{i.createdAt}</th><td>{i.amount}</td><td>{i.vat}</td><td>{t(i.statusKey)}</td><td dir="ltr">{i.etaUuid ?? ""}</td></tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </>
        )}
      </ScreenFrame>
    </section>
  );
}
