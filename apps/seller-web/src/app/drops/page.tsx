import { ActionForm } from "../../components/ActionForm";
import { ScreenFrame } from "../../components/ScreenFrame";
import { ServerCountdown } from "../../components/ServerCountdown";
import { loadDrops } from "../../loaders-phase2";
import { pageCtx } from "../../page-context";
import { DROP_TYPES } from "../../view-models/drops";
import { createDropAction, raiseStockAction, scheduleDropAction } from "../actions-phase2";

export default async function DropsPage() {
  const { ctx, t, locale } = await pageCtx();
  const state = await loadDrops(ctx);
  return (
    <section aria-labelledby="dr-h">
      <h2 id="dr-h">{t("drops.title")}</h2>
      <p className="hint">{t("drops.intro")}</p>
      <p className="hint">{t("p2.timesCairo")}</p>
      <ScreenFrame state={state} t={t}>
        {(vm) => (
          <>
            {vm.rows.length === 0 ? <p className="hint">{t("drops.none")}</p> : vm.rows.map((d) => (
              <article key={d.id} className="tile" aria-labelledby={`d-${d.id}`}>
                <h3 id={`d-${d.id}`}>{d.title}</h3>
                <p>
                  <span className="pill">{t(d.typeKey)}</span> <span className="pill">{t(d.stateKey)}</span>{" "}
                  {d.paused ? <span className="pill warn">{t("drops.paused")}</span> : null}
                </p>
                <dl>
                  <dt>{t("drops.col.starts")}</dt><dd>{d.startsAt} <ServerCountdown deadlineIso={d.startsAtIso} serverNowMs={d.serverTimeMs} locale={locale} label="countdown.starts" /></dd>
                  {d.earlyAccessAt === null ? null : <><dt>{t("drops.col.early")}</dt><dd>{d.earlyAccessAt}</dd></>}
                  <dt>{t("drops.col.ends")}</dt><dd>{d.endsAt}</dd>
                  <dt>{t("drops.col.limits")}</dt><dd>{d.limits}</dd>
                  {d.mystery === null ? null : <><dt>{t("drops.col.items")}</dt><dd>{t("drops.mystery", { range: d.mystery })}</dd></>}
                </dl>
                <ul>
                  {d.items.map((i) => (
                    <li key={i.sku}>
                      <span dir="ltr">{t("drops.items.line", { sku: i.sku, stock: i.stock, price: i.price })}</span>
                      {d.canRaiseStock ? (
                        <ActionForm
                          action={raiseStockAction} locale={locale} label={t("drops.raise.submit")}
                          hidden={{ id: d.id, sku: i.sku, price: i.priceMinor, current: String(i.stockCap), version: String(d.version), state: d.stateRaw }}
                        >
                          <div className="field">
                            <label htmlFor={`s-${d.id}-${i.sku}`}>{t("drops.raise.label", { sku: i.sku })}</label>
                            <input id={`s-${d.id}-${i.sku}`} name="stock" inputMode="numeric" min={i.stockCap} required dir="ltr" />
                          </div>
                        </ActionForm>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {d.canSchedule ? <ActionForm action={scheduleDropAction} locale={locale} label={t("drops.schedule")} hidden={{ id: d.id }} variant="primary" /> : <p className="hint">{t("drops.lockedNote")}</p>}
                {d.soldOutWaitlist ? <p className="banner">{t("drops.waitlist")}</p> : null}
              </article>
            ))}
            <h3>{t("drops.builder.title")}</h3>
            <ActionForm action={createDropAction} locale={locale} label={t("drops.create")} hidden={{}} variant="primary">
              <div className="field">
                <label htmlFor="n-type">{t("drops.field.type")}</label>
                <select id="n-type" name="type" required>{DROP_TYPES.map((x) => <option key={x} value={x}>{t(`drops.type.${x}`)}</option>)}</select>
              </div>
              <div className="field"><label htmlFor="n-title">{t("drops.field.title")}</label><input id="n-title" name="title" required minLength={2} maxLength={120} /></div>
              <div className="field"><label htmlFor="n-start">{t("drops.field.start")}</label><input id="n-start" name="startsAt" type="datetime-local" required dir="ltr" /></div>
              <div className="field"><label htmlFor="n-early">{t("drops.field.early")}</label><input id="n-early" name="earlyAccess" type="datetime-local" dir="ltr" /></div>
              <div className="field"><label htmlFor="n-end">{t("drops.field.end")}</label><input id="n-end" name="endsAt" type="datetime-local" required dir="ltr" /></div>
              <div className="field"><label htmlFor="n-sku">{t("drops.field.sku")}</label><input id="n-sku" name="skuId" required dir="ltr" autoComplete="off" /></div>
              <div className="field"><label htmlFor="n-stock">{t("drops.field.stock")}</label><input id="n-stock" name="stockCap" inputMode="numeric" required dir="ltr" /></div>
              <div className="field"><label htmlFor="n-price">{t("drops.field.price")}</label><input id="n-price" name="price" inputMode="decimal" required dir="ltr" /></div>
              <div className="field"><label htmlFor="n-pu">{t("drops.field.perUser")}</label><input id="n-pu" name="perUser" inputMode="numeric" required defaultValue="1" dir="ltr" /></div>
              <div className="field"><label htmlFor="n-pd">{t("drops.field.perDevice")}</label><input id="n-pd" name="perDevice" inputMode="numeric" required defaultValue="1" dir="ltr" /></div>
              <p className="hint">{t("drops.optionalNote")}</p>
              <div className="field"><label htmlFor="n-la">{t("drops.field.ladderAt")}</label><input id="n-la" name="ladderAt" type="datetime-local" dir="ltr" /></div>
              <div className="field"><label htmlFor="n-lp">{t("drops.field.ladderPrice")}</label><input id="n-lp" name="ladderPrice" inputMode="decimal" dir="ltr" /></div>
              <div className="field"><label htmlFor="n-m1">{t("drops.field.mysteryMin")}</label><input id="n-m1" name="mysteryMin" inputMode="decimal" dir="ltr" /></div>
              <div className="field"><label htmlFor="n-m2">{t("drops.field.mysteryMax")}</label><input id="n-m2" name="mysteryMax" inputMode="decimal" dir="ltr" /></div>
              <div className="field"><label htmlFor="n-m3">{t("drops.field.mysteryGuaranteed")}</label><input id="n-m3" name="mysteryGuaranteed" inputMode="decimal" dir="ltr" /></div>
            </ActionForm>
          </>
        )}
      </ScreenFrame>
    </section>
  );
}
