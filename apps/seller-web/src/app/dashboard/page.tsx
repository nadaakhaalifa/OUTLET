import { ScreenFrame } from "../../components/ScreenFrame";
import { loadDashboard, type DashboardVM } from "../../loaders";
import { pageCtx } from "../../page-context";
import type { Translator } from "../../i18n";

function Breakdown({ title, rows, suppressed, k, t, extra }: {
  title: string; rows: readonly { key: string; value: string; includesSuppressed: boolean; orders?: string }[]; suppressed: number; k: number; t: Translator; extra?: string;
}) {
  return (
    <section aria-labelledby={`h-${title}`}>
      <h3 id={`h-${title}`}>{title}</h3>
      {rows.length === 0 ? <p className="hint">{t("dashboard.empty")}</p> : (
        <div className="tablewrap">
          <table>
            <caption className="vh">{title}</caption>
            <thead><tr><th scope="col">{title}</th>{extra === undefined ? null : <th scope="col">{extra}</th>}<th scope="col">#</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <th scope="row">{r.key}{r.includesSuppressed ? ` (${t("dashboard.suppressedIncluded")})` : ""}</th>
                  {extra === undefined ? null : <td>{r.orders}</td>}
                  <td>{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {suppressed > 0 ? <p className="hint">{t("dashboard.suppressed", { count: suppressed, k })}</p> : null}
    </section>
  );
}

function View({ vm, t }: { vm: DashboardVM; t: Translator }) {
  return (
    <>
      <p className={vm.freshness.level === "within" ? "hint" : "banner"} role="status">
        {t(vm.freshness.key, { minutes: vm.freshness.sloMinutes })}
        {vm.freshness.asOf === null ? "" : ` ${t("common.asOf", { time: vm.freshness.asOf })}`}
      </p>
      <dl className="tiles">
        {vm.tiles.map((x) => (
          <div className="tile" key={x.id}>
            <dt>{t(x.labelKey)}</dt>
            <dd>{x.value ?? <span className="hint">{t("dashboard.noValue")}</span>}</dd>
          </div>
        ))}
      </dl>
      {vm.funnel === null ? null : (
        <section aria-labelledby="h-funnel">
          <h3 id="h-funnel">{t("dashboard.funnel")}</h3>
          <div className="tablewrap"><table>
            <caption className="vh">{t("dashboard.funnel")}</caption>
            <tbody>{vm.funnel.map((f) => <tr key={f.stage}><th scope="row">{f.stage}</th><td>{f.count}</td><td>{f.fromPrevious ?? ""}</td></tr>)}</tbody>
          </table></div>
        </section>
      )}
      {vm.traffic === null ? null : <Breakdown title={t("dashboard.traffic")} rows={vm.traffic.rows} suppressed={vm.traffic.suppressed} k={vm.kMin} t={t} />}
      {vm.geography === null ? null : (
        <Breakdown title={t("dashboard.geography")} rows={vm.geography.rows} suppressed={vm.geography.suppressed} k={vm.kMin} t={t} extra={t("dashboard.orders")} />
      )}
      {vm.aging === null || vm.aging.length === 0 ? null : (
        <section aria-labelledby="h-aging">
          <h3 id="h-aging">{t("dashboard.aging")}</h3>
          <p className="hint">{t("dashboard.markdownNotice")}</p>
          <div className="tablewrap"><table>
            <caption className="vh">{t("dashboard.aging")}</caption>
            <tbody>
              {vm.aging.map((a) => (
                <tr key={a.skuId}>
                  <th scope="row">{a.size}</th>
                  <td>{a.ageDays}</td><td>{a.onHand}</td><td>{a.price}</td>
                  <td>{a.suggested ?? ""}<br /><span className="hint">{a.notice}</span></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
      )}
    </>
  );
}

export default async function DashboardPage() {
  const { ctx, t } = await pageCtx();
  const state = await loadDashboard(ctx);
  return (
    <section aria-labelledby="dash-h">
      <h2 id="dash-h">{t("dashboard.title")}</h2>
      <ScreenFrame state={state} t={t}>{(vm) => <View vm={vm} t={t} />}</ScreenFrame>
    </section>
  );
}
