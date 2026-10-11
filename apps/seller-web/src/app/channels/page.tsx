import { ActionForm } from "../../components/ActionForm";
import { ScreenFrame } from "../../components/ScreenFrame";
import { ServerCountdown } from "../../components/ServerCountdown";
import { loadChannels } from "../../loaders-phase2";
import { pageCtx } from "../../page-context";
import { connectChannelAction } from "../actions-phase2";

export default async function ChannelsPage() {
  const { ctx, t, locale } = await pageCtx();
  const state = await loadChannels(ctx);
  return (
    <section aria-labelledby="ch-h">
      <h2 id="ch-h">{t("channels.title")}</h2>
      <p className="hint">{t("channels.intro")}</p>
      <ScreenFrame state={state} t={t}>
        {(vm, serverNowMs) => (
          <>
            <h3>{t("channels.parity.title")}</h3>
            <p className="hint">{t("channels.parity.note")}</p>
            {vm.parity.length === 0 ? <p className="hint">{t("channels.parity.none")}</p> : (
              <ul>{vm.parity.map((p) => (
                <li key={p.id} className="banner error">
                  <strong>{t("channels.parity.action", { action: p.action })}</strong> <span className="hint">{p.appliedAt}</span>{" "}
                  <ServerCountdown deadlineIso={p.fixDeadlineIso} serverNowMs={serverNowMs} locale={locale} label="countdown.remaining" />
                  {p.cure === null ? null : <p>{t("channels.parity.cure", { cure: p.cure })}</p>}
                </li>
              ))}</ul>
            )}

            <h3>{t("channels.incidents.title")}</h3>
            <p className="hint">{t("channels.incidents.note")}</p>
            {vm.incidents.length === 0 ? <p className="hint">{t("channels.incidents.none")}</p> : (
              <ul>{vm.incidents.map((i) => <li key={`${i.kind}-${i.id}`}><strong dir="ltr">{i.subject}</strong>: {t(i.reasonKey)}</li>)}</ul>
            )}

            <h3>{t("channels.list.title")}</h3>
            {vm.channels.length === 0 ? <p className="hint">{t("channels.none")}</p> : (
              <div className="tablewrap"><table>
                <caption className="vh">{t("channels.list.title")}</caption>
                <thead><tr>
                  <th scope="col">{t("channels.col.platform")}</th><th scope="col">{t("channels.col.domain")}</th>
                  <th scope="col">{t("channels.col.status")}</th><th scope="col">{t("channels.col.snapshot")}</th>
                </tr></thead>
                <tbody>{vm.channels.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">{t(`channels.type.${c.type}`)}</th><td dir="ltr">{c.domain}</td>
                    <td><span className={c.needsAttention ? "pill warn" : "pill"}>{t(c.statusKey)}</span></td>
                    <td>{c.lastSnapshot ?? <span className="hint">{t("channels.never")}</span>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}

            <h3>{t("channels.connect.title")}</h3>
            <p className="hint">{t("channels.connect.oauth")}</p>
            <ActionForm action={connectChannelAction} locale={locale} label={t("channels.connect.submit")} hidden={{}} variant="primary">
              <div className="field">
                <label htmlFor="ch-type">{t("channels.field.type")}</label>
                <select id="ch-type" name="type" required>
                  <option value="shopify">{t("channels.type.shopify")}</option>
                  <option value="woocommerce">{t("channels.type.woocommerce")}</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="ch-domain">{t("channels.field.domain")}</label>
                <input id="ch-domain" name="domain" required dir="ltr" autoComplete="off" inputMode="url" />
              </div>
            </ActionForm>
          </>
        )}
      </ScreenFrame>
    </section>
  );
}
