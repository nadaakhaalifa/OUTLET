import { ScreenFrame } from "../../components/ScreenFrame";
import { loadForecasts } from "../../loaders-phase2";
import { pageCtx } from "../../page-context";
import { HORIZONS, parseHorizon, parseScope, SCOPES } from "../../view-models/forecasts";

export default async function ForecastsPage({ searchParams }: { searchParams: Promise<{ scope?: string; horizon?: string }> }) {
  const sp = await searchParams;
  const scope = parseScope(sp.scope);
  const horizon = parseHorizon(sp.horizon);
  const { ctx, t } = await pageCtx();
  const state = await loadForecasts(ctx, { ...(scope === undefined ? {} : { scope }), ...(horizon === undefined ? {} : { horizon }) });
  return (
    <section aria-labelledby="fc-h">
      <h2 id="fc-h">{t("forecasts.title")}</h2>
      <p className="hint">{t("forecasts.intro")}</p>
      <form method="get" className="field-row">
        <div className="field">
          <label htmlFor="fc-scope">{t("forecasts.filter.scope")}</label>
          <select id="fc-scope" name="scope" defaultValue={scope ?? ""}>
            <option value="">{t("forecasts.filter.any")}</option>
            {SCOPES.map((s) => <option key={s} value={s}>{t(`forecasts.scope.${s}`)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fc-hz">{t("forecasts.filter.horizon")}</label>
          <select id="fc-hz" name="horizon" defaultValue={horizon ?? ""}>
            <option value="">{t("forecasts.filter.any")}</option>
            {HORIZONS.map((h) => <option key={h} value={h}>{t("forecasts.days", { n: h })}</option>)}
          </select>
        </div>
        <button type="submit" className="btn">{t("forecasts.filter.apply")}</button>
      </form>
      <ScreenFrame state={state} t={t}>
        {(vm) => vm.paused ? (
          <p role="status" className="banner">{t("forecasts.paused")}</p>
        ) : (
          <>
            <p className="banner" role="note">{vm.notice}</p>
            <p className="hint">{t("forecasts.advice")}</p>
            <p className="hint">{t("forecasts.asOf", { date: vm.asOf, time: vm.generatedAt })}</p>
            {vm.stale ? <p role="alert" className="banner error">{t("forecasts.stale")}</p> : null}
            {vm.rows.length === 0 ? <p className="hint">{t("forecasts.none")}</p> : (
              <div className="tablewrap" role="region" aria-label={t("forecasts.title")} tabIndex={0}><table>
                <caption className="vh">{t("forecasts.title")}</caption>
                <thead><tr>
                  <th scope="col">{t("forecasts.col.scope")}</th><th scope="col">{t("forecasts.col.horizon")}</th>
                  <th scope="col">{t("forecasts.col.range")}</th><th scope="col">{t("forecasts.col.coverage")}</th>
                  <th scope="col">{t("forecasts.col.basis")}</th>
                </tr></thead>
                <tbody>{vm.rows.map((r) => (
                  <tr key={r.key}>
                    <th scope="row">{t(`forecasts.scope.${r.scope}`)}<div className="hint" dir="ltr">{r.scopeKey}</div></th>
                    <td>{t("forecasts.days", { n: r.horizon })}</td>
                    {r.interval === null ? (
                      <td colSpan={2}>
                        <span className="pill warn">{t(r.status === "suppressed" ? "forecasts.status.suppressed" : "forecasts.status.insufficient")}</span>
                        <ul>{r.reasons.map((k) => <li key={k} className="hint">{t(k)}</li>)}</ul>
                      </td>
                    ) : (
                      <>
                        <td>
                          <span className="vh">{t("forecasts.rangeSr", { low: r.interval.p10, mid: r.interval.p50, high: r.interval.p90 })}</span>
                          <span aria-hidden="true" dir="ltr">{r.interval.p10} / {r.interval.p50} / {r.interval.p90}</span>
                          <div className="hint">{t("forecasts.rangeLegend")}</div>
                        </td>
                        <td>{t("forecasts.nominal", { pct: r.interval.coverage })}</td>
                      </>
                    )}
                    <td>
                      {r.modelKey === null ? null : <div>{t(r.modelKey)}</div>}
                      {r.history === null ? null : <div className="hint">{t("forecasts.history", { n: r.history })}</div>}
                      {r.backtestCoverage === null ? null : <div className="hint">{t("forecasts.backtest", { pct: r.backtestCoverage })}</div>}
                      {r.interval === null ? null : <ul>{r.reasons.map((k) => <li key={k} className="hint">{t(k)}</li>)}</ul>}
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            {vm.hasMore ? <p className="hint">{t("forecasts.more")}</p> : null}
          </>
        )}
      </ScreenFrame>
    </section>
  );
}
