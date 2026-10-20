import { ErrorBlock, Flash, PageHeader, WritesDisabledNote } from "../../../components/ui";
import { OddsEditor, type OddsEditorLabels } from "../../../components/odds-editor";
import { SwitchStrip } from "../../../components/switch-strip";
import { publishOddsAction, saveRewardsAction } from "../../../server/actions";
import { getConsole } from "../../../server/console";
import { stateFor } from "../../../view-models/killswitch";

export default async function RewardsPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const [r, f] = await Promise.all([c.api.rewardsConfig(), c.api.flags("kill_switch")]);
  const writes = c.posture.sensitiveWritesEnabled;
  const cfg = r.ok ? r.value.data : null;
  const labels: OddsEditorLabels = {
    id: c.t("rewards.outcome.id"), kind: c.t("rewards.outcome.kind"), percent: c.t("rewards.outcome.percent"), coins: c.t("rewards.outcome.coins"),
    voucher: c.t("rewards.outcome.voucher"),
    kinds: { nothing: c.t("rewards.kind.nothing"), coins: c.t("rewards.kind.coins"), voucher: c.t("rewards.kind.voucher") },
    add: c.t("rewards.addRow"), remove: c.t("rewards.removeRow"), total: c.t("rewards.total", { total: "{{total}}" }), publish: c.t("rewards.publish"),
    refused: c.t("common.refused"), approvalId: c.t("common.approvalId"), approvalHelp: c.t("common.approvalHelp"), game: "",
    errors: {
      empty: c.t("rewards.err.empty"), too_many: c.t("rewards.err.too_many"), id: c.t("rewards.err.id"), duplicate_id: c.t("rewards.err.duplicate_id"),
      kind: c.t("rewards.err.kind"), percent: c.t("rewards.err.percent"), coins: c.t("rewards.err.coins"), voucher: c.t("rewards.err.voucher"), sum: c.t("rewards.err.sum"),
    },
  };
  const games = f.ok ? stateFor(f.value.data.items, "kill.games").state : "blocked";
  return (
    <>
      <PageHeader title={c.t("rewards.title")} intro={c.t("rewards.intro")} />
      <Flash code={sp.r} t={c.t} />
      <WritesDisabledNote c={c} />
      <p role="status">{c.t("rewards.gamesState", { state: c.t(games === "allowed" ? "sw.allowed" : "sw.blocked") })}</p>
      <SwitchStrip items={f.ok ? f.value.data.items : null} keys={["kill.games", "kill.rewards_coins"]} c={c} />
      <p><a href="/flags">{c.t("nav.flags")}</a></p>
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : cfg === null ? null : (
        <section className="card">
          <h2>{c.t("rewards.config", { version: cfg.version })}</h2>
          <form action={saveRewardsAction}>
            <label htmlFor="rw-p">{c.t("rewards.piastres")}</label><input id="rw-p" name="piastres_per_coin" defaultValue={cfg.piastres_per_coin} required inputMode="numeric" dir="ltr" />
            <label htmlFor="rw-s">{c.t("rewards.silver")}</label><input id="rw-s" name="silver_from" defaultValue={cfg.silver_from} required inputMode="numeric" dir="ltr" />
            <label htmlFor="rw-g">{c.t("rewards.gold")}</label><input id="rw-g" name="gold_from" defaultValue={cfg.gold_from} required inputMode="numeric" dir="ltr" />
            <label htmlFor="rw-b">{c.t("rewards.black")}</label><input id="rw-b" name="black_from" defaultValue={cfg.black_from} required inputMode="numeric" dir="ltr" />
            <label htmlFor="rw-m">{c.t("rewards.maxEvent")}</label><input id="rw-m" name="max_coins_per_event" defaultValue={cfg.max_coins_per_event} required inputMode="numeric" dir="ltr" />
            <label htmlFor="rw-a">{c.t("common.approvalId")}</label><input id="rw-a" name="approval_id" required dir="ltr" aria-describedby="rw-ah" />
            <p id="rw-ah" className="muted">{c.t("common.approvalHelp")}</p>
            <button type="submit" className="btn primary" disabled={!writes}>{c.t("common.save")}</button>
          </form>
        </section>
      )}
      <h2>{c.t("rewards.games")}</h2>
      {(["daily_spin", "scratch_card"] as const).map((g) => (
        <OddsEditor key={g} game={g} action={publishOddsAction} labels={{ ...labels, game: c.t(`rewards.game.${g}`) }} disabled={!writes} />
      ))}
    </>
  );
}
