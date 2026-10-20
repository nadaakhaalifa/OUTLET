import { ActionForm } from "../../components/ActionForm";
import { ScreenFrame } from "../../components/ScreenFrame";
import { loadResale } from "../../loaders-phase2";
import { pageCtx } from "../../page-context";
import { withdrawResaleAction } from "../actions-phase2";

export default async function ResalePage() {
  const { ctx, t, locale } = await pageCtx();
  const state = await loadResale(ctx);
  return (
    <section aria-labelledby="rs-h">
      <h2 id="rs-h">{t("resale.title")}</h2>
      <p className="hint">{t("resale.intro")}</p>
      <p className="banner" role="note">{t("resale.rule")}</p>
      <p className="hint">{t("resale.gradeNote")}</p>
      <p className="hint">{t("resale.hubNote")}</p>
      <ScreenFrame state={state} t={t}>
        {(vm) => vm.rows.length === 0 ? <p className="hint">{t("resale.none")}</p> : (
          <div className="tablewrap"><table>
            <caption className="vh">{t("resale.title")}</caption>
            <thead><tr>
              <th scope="col">{t("resale.col.sku")}</th><th scope="col">{t("resale.col.grade")}</th><th scope="col">{t("resale.col.price")}</th>
              <th scope="col">{t("resale.col.status")}</th><th scope="col">{t("resale.col.ownership")}</th><th scope="col">{t("resale.col.listed")}</th>
              <th scope="col"><span className="vh">{t("resale.withdraw")}</span></th>
            </tr></thead>
            <tbody>{vm.rows.map((r) => (
              <tr key={r.id}>
                <th scope="row" dir="ltr">{r.sku}</th><td>{t(r.gradeKey)}</td><td>{r.price}</td><td>{t(r.statusKey)}</td><td dir="ltr">{r.ownership}</td><td>{r.listedAt}</td>
                <td>{r.canWithdraw ? <ActionForm action={withdrawResaleAction} locale={locale} label={t("resale.withdraw")} hidden={{ id: r.id, storeId: vm.storeId }} variant="danger" /> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </ScreenFrame>
    </section>
  );
}
