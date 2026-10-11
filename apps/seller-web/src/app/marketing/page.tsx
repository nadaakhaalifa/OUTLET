import { ActionForm } from "../../components/ActionForm";
import { ScreenFrame } from "../../components/ScreenFrame";
import { setPromotionStatusAction } from "../actions";
import { loadMarketing } from "../../loaders";
import { pageCtx } from "../../page-context";

export default async function MarketingPage() {
  const { ctx, t, locale } = await pageCtx();
  const state = await loadMarketing(ctx);
  return (
    <section aria-labelledby="mk-h">
      <h2 id="mk-h">{t("marketing.title")}</h2>
      <p className="hint">{t("marketing.note")}</p>
      <ScreenFrame state={state} t={t}>
        {(vm) => (
          <div className="tablewrap"><table>
            <caption className="vh">{t("marketing.title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("marketing.col.title")}</th><th scope="col">{t("marketing.col.code")}</th><th scope="col">{t("marketing.col.status")}</th>
                <th scope="col">{t("marketing.col.funding")}</th><th scope="col">{t("marketing.col.period")}</th><th scope="col"><span className="vh">{t("marketing.pause")}</span></th>
              </tr>
            </thead>
            <tbody>
              {vm.rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.title}</th>
                  <td dir="ltr">{r.code ?? ""}</td>
                  <td>{t(r.statusKey)}</td>
                  <td>{t("marketing.funding", { seller: r.sellerPct, platform: r.platformPct })}</td>
                  <td>{r.period}</td>
                  <td>
                    {r.canPause ? <ActionForm action={setPromotionStatusAction} locale={locale} label={t("marketing.pause")} hidden={{ id: r.id, status: "paused" }} /> : null}
                    {r.canResume ? <ActionForm action={setPromotionStatusAction} locale={locale} label={t("marketing.resume")} hidden={{ id: r.id, status: "active" }} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </ScreenFrame>
    </section>
  );
}
