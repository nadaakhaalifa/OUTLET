import { ErrorBlock, PageHeader } from "../../../components/ui";
import { SwitchStrip } from "../../../components/switch-strip";
import { formatInt, formatMoney } from "../../../lib/format";
import { getConsole } from "../../../server/console";
import { adsView } from "../../../view-models/phase2ops";
import type { MessageKey } from "../../../i18n";

export default async function AdsPage() {
  const c = await getConsole();
  const [r, f] = await Promise.all([c.api.adsConfig(), c.api.flags("kill_switch")]);
  const v = r.ok ? adsView(r.value.data) : null;
  return (
    <>
      <PageHeader title={c.t("ads.title")} intro={c.t("ads.intro")} />
      <SwitchStrip items={f.ok ? f.value.data.items : null} keys={["kill.sponsored_products"]} c={c} />
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : v === null ? null : (
        <>
          <dl>
            <dt>{c.t("ads.slots")}</dt><dd>{formatInt(v.slots, c.locale)}</dd>
            <dt>{c.t("ads.pricing")}</dt><dd dir="ltr">{v.pricing}</dd>
            <dt>{c.t("ads.floor")}</dt><dd>{formatMoney(v.floorMinor, c.locale)}</dd>
            <dt>{c.t("ads.botBlock")}</dt><dd dir="ltr">{v.botBlockPercent}%</dd>
            <dt>{c.t("ads.vat")}</dt><dd dir="ltr">{v.vatPercent}%</dd>
          </dl>
          <h2>{c.t("ads.limits")}</h2>
          <ul>{v.limits.map((l) => (
            <li key={l.key}>{c.t(`ads.limit.${l.key}` as MessageKey)}: <span dir="ltr">{formatInt(l.value, c.locale)}{l.unit === "ms" ? " ms" : ""}</span></li>
          ))}</ul>
        </>
      )}
      <h2>{c.t("ads.queue")}</h2>
      <p className="muted">{c.t("common.noEndpoint")}</p>
    </>
  );
}
