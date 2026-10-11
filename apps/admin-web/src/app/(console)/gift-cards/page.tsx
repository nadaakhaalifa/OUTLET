import { ErrorBlock, Flash, PageHeader, WritesDisabledNote } from "../../../components/ui";
import { SwitchStrip } from "../../../components/switch-strip";
import { voidGiftCardAction } from "../../../server/actions";
import { getConsole } from "../../../server/console";

export default async function GiftCardsPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const f = await c.api.flags("kill_switch");
  const writes = c.posture.sensitiveWritesEnabled;
  return (
    <>
      <PageHeader title={c.t("gift.title")} intro={c.t("gift.intro")} />
      <Flash code={sp.r} t={c.t} />
      <WritesDisabledNote c={c} />
      <h2>{c.t("gift.switches")}</h2>
      {!f.ok ? <ErrorBlock error={f.error} c={c} /> : <SwitchStrip items={f.value.data.items} keys={["kill.gift_card_sales", "kill.gift_card_redemption"]} c={c} />}
      <p><a href="/flags">{c.t("nav.flags")}</a></p>
      <section className="card">
        <h2>{c.t("gift.voidTitle")}</h2>
        <p className="muted">{c.t("gift.voidNote")}</p>
        <form action={voidGiftCardAction}>
          <label htmlFor="gc-id">{c.t("gift.cardId")}</label>
          <input id="gc-id" name="id" required dir="ltr" />
          <button type="submit" className="btn danger" disabled={!writes}>{c.t("gift.void")}</button>
        </form>
      </section>
      <section><h2>{c.t("gift.pots")}</h2><p className="muted">{c.t("common.noEndpoint")}</p></section>
      <section><h2>{c.t("gift.throttle")}</h2><p className="muted">{c.t("common.noEndpoint")}</p></section>
    </>
  );
}
