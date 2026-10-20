import { ActionForm } from "../../components/ActionForm";
import { ScreenFrame } from "../../components/ScreenFrame";
import { StatTiles } from "../../components/StatTiles";
import { loadAds } from "../../loaders-phase2";
import { pageCtx } from "../../page-context";
import { SPONSORED_RULES } from "../../view-models/ads";
import { createCampaignAction, setCampaignStatusAction, topUpAction } from "../actions-phase2";

export default async function AdsPage() {
  const { ctx, t, locale } = await pageCtx();
  const state = await loadAds(ctx);
  return (
    <section aria-labelledby="ads-h">
      <h2 id="ads-h">{t("ads.title")}</h2>
      <p className="hint">{t("ads.intro")}</p>
      <section aria-labelledby="ads-rules" className="banner">
        <h3 id="ads-rules">{t("ads.rules.title")}</h3>
        <ul>{SPONSORED_RULES.map((k) => <li key={k}>{t(k)}</li>)}</ul>
      </section>
      <ScreenFrame state={state} t={t}>
        {(vm) => (
          <>
            <h3>{t("ads.balance.title")}</h3>
            {vm.balance === null ? <p className="hint">{t("ads.balance.unavailable")}</p> : (
              <>
                <dl className="tiles">
                  <div className="tile"><dt>{t("ads.balance.current")}</dt><dd>{vm.balance.balance}</dd></div>
                  <div className="tile"><dt>{t("ads.balance.caps")}</dt><dd>{vm.balance.activeDailyCaps}</dd></div>
                </dl>
                {vm.balance.belowDailyCaps ? <p role="alert" className="banner error">{t("ads.balance.below")}</p> : null}
                <p className="hint">{t("ads.topup.vat")}</p>
                {vm.balance.topUps.length === 0 ? null : (
                  <div className="tablewrap"><table>
                    <caption>{t("ads.topup.history")}</caption>
                    <thead><tr>
                      <th scope="col">{t("ads.topup.status")}</th><th scope="col">{t("ads.topup.net")}</th>
                      <th scope="col">{t("ads.topup.vatCol")}</th><th scope="col">{t("ads.topup.gross")}</th>
                    </tr></thead>
                    <tbody>{vm.balance.topUps.map((x) => (
                      <tr key={x.id}><th scope="row">{x.status}</th><td>{x.net}</td><td>{x.vat}</td><td>{x.gross}</td></tr>
                    ))}</tbody>
                  </table></div>
                )}
              </>
            )}
            <h3>{t("ads.topup.title")}</h3>
            <ActionForm action={topUpAction} locale={locale} label={t("ads.topup.submit")} hidden={{ storeId: vm.storeId }} variant="primary">
              <div className="field">
                <label htmlFor="topup-amount">{t("ads.topup.amount")}</label>
                <input id="topup-amount" name="amount" inputMode="decimal" autoComplete="off" required dir="ltr" />
              </div>
            </ActionForm>

            <h3>{t("ads.performance")}</h3>
            {vm.tiles === null ? <p className="hint">{t("ads.reportUnavailable")}</p> : (
              <>
                {vm.period === null ? null : <p className="hint">{t("ads.period", { period: vm.period })}</p>}
                <StatTiles tiles={vm.tiles} t={t} />
                {vm.perCampaign.map((c) => (
                  <details key={c.id}>
                    <summary>{c.name}</summary>
                    <StatTiles tiles={c.tiles} t={t} />
                  </details>
                ))}
                <p className="hint">{t("ads.invalid")}</p>
              </>
            )}

            <h3>{t("ads.campaigns")}</h3>
            {vm.campaigns.length === 0 ? <p className="hint">{t("ads.noCampaigns")}</p> : (
              <div className="tablewrap"><table>
                <caption className="vh">{t("ads.campaigns")}</caption>
                <thead><tr>
                  <th scope="col">{t("ads.col.name")}</th><th scope="col">{t("ads.col.status")}</th><th scope="col">{t("ads.col.budget")}</th>
                  <th scope="col">{t("ads.col.cpc")}</th><th scope="col">{t("ads.col.bids")}</th><th scope="col">{t("ads.col.period")}</th>
                  <th scope="col"><span className="vh">{t("ads.pause")}</span></th>
                </tr></thead>
                <tbody>{vm.campaigns.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">{c.name}</th><td>{t(c.statusKey)}</td><td>{c.dailyBudget}</td><td>{c.maxCpc}</td><td>{c.bids}</td><td>{c.period}</td>
                    <td>
                      {c.canPause ? <ActionForm action={setCampaignStatusAction} locale={locale} label={t("ads.pause")} hidden={{ id: c.id, to: "pause" }} /> : null}
                      {c.canResume ? <ActionForm action={setCampaignStatusAction} locale={locale} label={t("ads.resume")} hidden={{ id: c.id, to: "resume" }} /> : null}
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}

            <h3>{t("ads.new.title")}</h3>
            <p className="hint">{t("p2.timesCairo")}</p>
            <ActionForm action={createCampaignAction} locale={locale} label={t("ads.create")} hidden={{ storeId: vm.storeId }} variant="primary">
              <div className="field"><label htmlFor="c-name">{t("ads.field.name")}</label><input id="c-name" name="name" required minLength={2} maxLength={80} /></div>
              <div className="field"><label htmlFor="c-budget">{t("ads.field.budget")}</label><input id="c-budget" name="dailyBudget" inputMode="decimal" required dir="ltr" /></div>
              <div className="field"><label htmlFor="c-cpc">{t("ads.field.cpc")}</label><input id="c-cpc" name="maxCpc" inputMode="decimal" required dir="ltr" /></div>
              <div className="field"><label htmlFor="c-start">{t("ads.field.start")}</label><input id="c-start" name="startsAt" type="datetime-local" required dir="ltr" /></div>
              <div className="field"><label htmlFor="c-end">{t("ads.field.end")}</label><input id="c-end" name="endsAt" type="datetime-local" dir="ltr" /></div>
              <div className="field"><label htmlFor="c-product">{t("ads.field.product")}</label><input id="c-product" name="productId" required dir="ltr" autoComplete="off" /></div>
              <div className="field"><label htmlFor="c-bid">{t("ads.field.bid")}</label><input id="c-bid" name="bid" inputMode="decimal" required dir="ltr" /></div>
              <div className="field"><label htmlFor="c-kw">{t("ads.field.keywords")}</label><input id="c-kw" name="keywords" /></div>
            </ActionForm>
          </>
        )}
      </ScreenFrame>
    </section>
  );
}
