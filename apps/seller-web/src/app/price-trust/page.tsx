import { ScreenFrame } from "../../components/ScreenFrame";
import { loadPriceTrust } from "../../loaders";
import { pageCtx } from "../../page-context";

export default async function PriceTrustPage() {
  const { ctx, t } = await pageCtx();
  const state = await loadPriceTrust(ctx);
  return (
    <section aria-labelledby="pt-h">
      <h2 id="pt-h">{t("trust.title")}</h2>
      <ScreenFrame state={state} t={t}>
        {(vm) => (
          <>
            <dl className="tiles">
              <div className="tile"><dt>{t("trust.score")}</dt><dd>{vm.score}</dd></div>
              <div className="tile"><dt>{t("trust.violations", { days: vm.windowDays })}</dt><dd>{vm.violations}</dd></div>
              <div className="tile"><dt>{t("trust.actions")}</dt><dd>{t(vm.ladderKey)}</dd></div>
            </dl>
            <h3>{t("trust.actions")}</h3>
            {vm.actions.length === 0 ? <p className="hint">{t("trust.noActions")}</p> : (
              <ul>
                {vm.actions.map((a) => (
                  <li key={a.id}>
                    <strong dir="ltr">{a.action}</strong> <span className="hint">{a.appliedAt}</span>
                    {a.cure === null ? null : <p>{t("trust.cure")}: {a.cure}</p>}
                  </li>
                ))}
              </ul>
            )}
            <h3>{t("trust.claims")}</h3>
            <p className="hint">{t("trust.appealNote")}</p>
            {vm.claims.length === 0 ? <p className="hint">{t("state.empty")}</p> : (
              <ul>
                {vm.claims.map((c) => (
                  <li key={c.id}>
                    <strong>{t(c.decisionKey)}</strong> <span className="hint">{c.evaluatedAt}</span>
                    {c.hints.length === 0 ? null : <ul>{c.hints.map((h, i) => <li key={i}>{h}</li>)}</ul>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </ScreenFrame>
    </section>
  );
}
