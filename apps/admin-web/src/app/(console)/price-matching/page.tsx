import Link from "next/link";
import { Badge, ErrorBlock, PageHeader } from "../../../components/ui";
import { SwitchStrip } from "../../../components/switch-strip";
import { getConsole } from "../../../server/console";
import { matchingView } from "../../../view-models/phase2ops";

export default async function PriceMatchingPage() {
  const c = await getConsole();
  const [r, f] = await Promise.all([c.api.priceMatchingConfig(), c.api.flags("kill_switch")]);
  const v = r.ok ? matchingView(r.value.data) : null;
  return (
    <>
      <PageHeader title={c.t("match.title")} intro={c.t("match.intro")} />
      <SwitchStrip items={f.ok ? f.value.data.items : null} keys={["kill.crawlers"]} c={c} />
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : v === null ? null : (
        <section className="card">
          <p><strong>{c.t("match.tau")}: <span dir="ltr">{v.tauPercent}%</span></strong> (v{v.version})</p>
          <p><Badge tone={v.shadowOnly ? "warn" : "ok"}>{c.t(v.shadowOnly ? "match.shadow" : "match.live")}</Badge></p>
          <p>{c.t("match.labelled", { n: v.labelledPairs, target: v.targetPairs })}</p>
          <progress max={v.targetPairs} value={Math.min(v.labelledPairs, v.targetPairs)} aria-label={c.t("match.labelled", { n: v.labelledPairs, target: v.targetPairs })} />
          {v.remainingPairs > 0 ? <p className="muted">{c.t("match.remaining", { n: v.remainingPairs })}</p> : null}
          <p>{c.t("match.kappa")}: <span dir="ltr">{v.kappa}</span></p>
        </section>
      )}
      <h2>{c.t("match.incidents")}</h2>
      <p className="muted">{c.t("common.noEndpoint")}</p>
      <h2>{c.t("match.ladder")}</h2>
      <p><Link href="/price-integrity">{c.t("match.ladderLink")}</Link></p>
    </>
  );
}
