import { ScreenFrame } from "../../components/ScreenFrame";
import { loadInsights } from "../../loaders-phase2";
import { pageCtx } from "../../page-context";

export default async function InsightsPage() {
  const { ctx, t } = await pageCtx();
  const state = await loadInsights(ctx);
  return (
    <section aria-labelledby="in-h">
      <h2 id="in-h">{t("insights.title")}</h2>
      <ScreenFrame state={state} t={t}>
        {(vm) => (
          <>
            {vm.asOf === null ? null : <p className="hint">{t("insights.asOf", { time: vm.asOf })}</p>}
            <p className="banner" role="note">{vm.kMin > 0 ? t("insights.k", { k: vm.kMin }) : t("insights.kUnknown")}</p>

            <h3>{t("insights.markdown.title")}</h3>
            <p className="hint">{t("insights.markdown.note")}</p>
            {vm.markdown === null ? <p className="hint">{t("p2.unavailable")}</p> : vm.markdown.length === 0 ? <p className="hint">{t("insights.markdown.none")}</p> : (
              <div className="tablewrap"><table>
                <caption className="vh">{t("insights.markdown.title")}</caption>
                <thead><tr>
                  <th scope="col">{t("insights.col.sku")}</th><th scope="col">{t("insights.col.severity")}</th><th scope="col">{t("insights.col.age")}</th>
                  <th scope="col">{t("insights.col.onHand")}</th><th scope="col">{t("insights.col.sellThrough")}</th>
                  <th scope="col">{t("insights.col.price")}</th><th scope="col">{t("insights.col.suggested")}</th>
                </tr></thead>
                <tbody>{vm.markdown.map((r) => (
                  <tr key={r.skuId}>
                    <th scope="row"><span dir="ltr">{r.skuId}</span> / {r.size}</th>
                    <td>{t(r.severityKey)}</td><td>{r.ageDays}</td><td>{r.onHand}</td>
                    <td>{r.sellThrough ?? <span className="hint">{t("p2.noValue")}</span>}</td>
                    <td>{r.price}</td>
                    <td>
                      {r.suggested ?? <span className="hint">{t("insights.noSuggestion")}</span>}
                      <p className="hint">{r.notice}</p>
                      {r.percentOffBlocked ? <p className="hint">{t("insights.markdown.blocked")}</p> : null}
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}

            <h3>{t("insights.size.title")}</h3>
            {vm.sizeCurve === null ? <p className="hint">{t("p2.unavailable")}</p> : vm.sizeCurve.length === 0 ? <p className="hint">{t("insights.size.none")}</p> : vm.sizeCurve.map((p) => (
              <div className="tablewrap" key={p.productId}><table>
                <caption>{t("insights.size.product", { id: p.productId, sold: p.totalSold, stocked: p.totalStocked })}</caption>
                <thead><tr>
                  <th scope="col">{t("insights.col.size")}</th><th scope="col">{t("insights.col.sold")}</th><th scope="col">{t("insights.col.onHand")}</th>
                  <th scope="col">{t("insights.col.soldShare")}</th><th scope="col">{t("insights.col.stockedShare")}</th><th scope="col">{t("insights.col.gap")}</th>
                </tr></thead>
                <tbody>{p.rows.map((r) => (
                  <tr key={r.size}>
                    <th scope="row">{r.size}</th><td>{r.sold}</td><td>{r.onHand}</td>
                    <td>{r.soldShare ?? <span className="hint">{t("p2.noValue")}</span>}</td>
                    <td>{r.stockedShare ?? <span className="hint">{t("p2.noValue")}</span>}</td>
                    <td>{r.gapKey === null || r.gap === null ? <span className="hint">{t("p2.noValue")}</span> : t(r.gapKey, { gap: r.gap })}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            ))}

            <h3>{t("insights.stylist.title")}</h3>
            <p className="hint">{t("insights.stylist.unavailable")}</p>
          </>
        )}
      </ScreenFrame>
    </section>
  );
}
