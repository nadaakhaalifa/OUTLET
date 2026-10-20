import { z } from "zod";
import { Badge, Empty, ErrorBlock, Flash, PageHeader, WritesDisabledNote } from "../../../components/ui";
import { SwitchStrip } from "../../../components/switch-strip";
import { evaluateGuardrailsAction, runRankingEvaluationAction } from "../../../server/actions-phase3";
import { getConsole } from "../../../server/console";
import { formatDateTime, formatInt } from "../../../lib/format";
import { evaluationRows, shadowView } from "../../../view-models/ranking";

const Result = z.object({
  g: z.enum(["continue", "halt", "insufficient_data"]),
  gb: z.string().max(80).optional(),
  grd: z.string().regex(/^-?\d{0,6}$/).optional(),
  gcd: z.string().regex(/^-?\d{0,6}$/).optional(),
});

export default async function RankingPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const [summary, evals, flags] = await Promise.all([c.api.rankingShadowSummary(), c.api.rankingEvaluations(), c.api.flags("kill_switch")]);
  const writes = c.posture.sensitiveWritesEnabled;
  const sh = summary.ok ? shadowView(summary.value.data) : null;
  const rows = evals.ok ? evaluationRows(evals.value.data.items) : [];
  const res = Result.safeParse(sp);
  const breaches = res.success ? (res.data.gb ?? "").split(",").filter((x) => x === "return_rate" || x === "complaint_rate") : [];
  return (
    <>
      <PageHeader title={c.t("ranking.title")} intro={c.t("ranking.intro")} />
      <Flash code={sp.r} t={c.t} />
      <WritesDisabledNote c={c} />
      <p className="muted">{c.t("ranking.restricted")}</p>
      <SwitchStrip items={flags.ok ? flags.value.data.items : null} keys={["kill.ranking_v2_shadow", "kill.ml_ranking"]} c={c} />
      <p><a href="/flags">{c.t("nav.flags")}</a></p>

      <section aria-labelledby="rk-shadow">
        <h2 id="rk-shadow">{c.t("ranking.shadow")}</h2>
        {!summary.ok || sh === null ? (summary.ok ? null : <ErrorBlock error={summary.error} c={c} />) : (
          <>
            <p>{c.t("ranking.served", { version: sh.served })} <span className="muted">({c.t("ranking.window")}: {sh.windowHours})</span></p>
            {sh.runs === 0 ? <p className="muted">{c.t("ranking.noRuns")}</p> : null}
            <dl>
              <dt>{c.t("ranking.runs")}</dt><dd>{formatInt(sh.runs, c.locale)}</dd>
              <dt>{c.t("ranking.personalized")}</dt><dd>{formatInt(sh.personalizedRuns, c.locale)}</dd>
              <dt>{c.t("ranking.botFiltered")}</dt><dd>{formatInt(sh.botFilteredRuns, c.locale)}</dd>
              <dt>{c.t("ranking.overlap")}</dt><dd dir="ltr">{sh.meanOverlap ?? c.t("common.notMeasured")}</dd>
              <dt>{c.t("ranking.top1")}</dt><dd dir="ltr">{sh.top1Same ?? c.t("common.notMeasured")}</dd>
              <dt>{c.t("ranking.shift")}</dt><dd dir="ltr">{sh.meanRankShift ?? c.t("common.notMeasured")}</dd>
              <dt>{c.t("ranking.versions")}</dt><dd dir="ltr">{sh.versions.length === 0 ? c.t("common.notMeasured") : sh.versions.join(", ")}</dd>
            </dl>
          </>
        )}
      </section>

      <section aria-labelledby="rk-evals">
        <h2 id="rk-evals">{c.t("ranking.evals")}</h2>
        {!evals.ok ? <ErrorBlock error={evals.error} c={c} /> : rows.length === 0 ? <Empty t={c.t} /> : (
          <div className="table-wrap"><table>
            <thead><tr>
              <th>{c.t("ranking.col.key")}</th><th>{c.t("ranking.col.candidate")}</th><th>{c.t("ranking.col.baseline")}</th><th>{c.t("ranking.col.dataset")}</th>
              <th>{c.t("ranking.col.volume")}</th><th>{c.t("ranking.col.ndcg")}</th><th>{c.t("ranking.col.map")}</th><th>{c.t("ranking.col.delta")}</th>
              <th>{c.t("ranking.col.result")}</th><th>{c.t("ranking.col.created")}</th>
            </tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id}>
                <td dir="ltr">{e.requestKey}</td><td dir="ltr">{e.candidate}</td><td dir="ltr">{e.baseline}</td>
                <td>{c.t(`ranking.dataset.${e.dataset}`)}</td>
                <td dir="ltr">{e.requests} / {e.k}</td>
                <td dir="ltr">{e.candidateNdcg} / {e.baselineNdcg}</td>
                <td dir="ltr">{e.candidateMap} / {e.baselineMap}</td>
                <td dir="ltr">{e.ndcgDeltaBps > 0 ? "+" : ""}{e.ndcgDeltaBps} bps</td>
                <td><Badge tone={e.passed ? "ok" : "bad"}>{c.t(e.passed ? "ranking.pass" : "ranking.fail")}</Badge>
                  {e.reasons.length === 0 ? null : <div className="muted" dir="ltr">{e.reasons.join(", ")}</div>}</td>
                <td>{formatDateTime(e.createdAt, c.locale)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <div className="card">
          <h3>{c.t("ranking.run")}</h3>
          <p className="muted">{c.t("ranking.runHelp")}</p>
          <form action={runRankingEvaluationAction}>
            <label htmlFor="rk-key">{c.t("ranking.f.key")}</label><input id="rk-key" name="request_key" required minLength={8} maxLength={80} dir="ltr" pattern="[A-Za-z0-9_.:\-]+" />
            <label htmlFor="rk-cand">{c.t("ranking.f.candidate")}</label><input id="rk-cand" name="candidate" required maxLength={40} dir="ltr" />
            <label htmlFor="rk-base">{c.t("ranking.f.baseline")}</label><input id="rk-base" name="baseline" required maxLength={40} dir="ltr" />
            <label htmlFor="rk-seed">{c.t("ranking.f.seed")}</label><input id="rk-seed" name="seed" inputMode="numeric" dir="ltr" />
            <label htmlFor="rk-req">{c.t("ranking.f.requests")}</label><input id="rk-req" name="requests" inputMode="numeric" dir="ltr" />
            <label htmlFor="rk-k">{c.t("ranking.f.k")}</label><input id="rk-k" name="k" inputMode="numeric" dir="ltr" />
            <button type="submit" className="btn primary" disabled={!writes}>{c.t("ranking.run")}</button>
          </form>
        </div>
      </section>

      <section aria-labelledby="rk-guard">
        <h2 id="rk-guard">{c.t("ranking.guard")}</h2>
        <p className="muted">{c.t("ranking.guardHelp")}</p>
        {!res.success ? null : (
          <div role="status" className={res.data.g === "continue" ? "notice ok" : "notice error"}>
            <p>{c.t("ranking.g.result", { decision: c.t(`ranking.g.${res.data.g}`) })}</p>
            <p>{breaches.length === 0 ? c.t("ranking.g.noBreaches") : c.t("ranking.g.breaches", { list: breaches.map((b) => c.t(b === "return_rate" ? "ranking.g.return_rate" : "ranking.g.complaint_rate")).join(", ") })}</p>
            {res.data.grd === undefined || res.data.grd === "" ? null : <p dir="ltr">{c.t("ranking.g.returnDelta", { bps: res.data.grd })}</p>}
            {res.data.gcd === undefined || res.data.gcd === "" ? null : <p dir="ltr">{c.t("ranking.g.complaintDelta", { bps: res.data.gcd })}</p>}
          </div>
        )}
        <form action={evaluateGuardrailsAction} className="card">
          {([["c", "ranking.g.control"], ["t", "ranking.g.treatment"]] as const).map(([p, label]) => (
            <fieldset key={p}>
              <legend>{c.t(label)}</legend>
              <label htmlFor={`rg-${p}-o`}>{c.t("ranking.g.orders")}</label><input id={`rg-${p}-o`} name={`${p}_orders`} required inputMode="numeric" dir="ltr" />
              <label htmlFor={`rg-${p}-r`}>{c.t("ranking.g.returned")}</label><input id={`rg-${p}-r`} name={`${p}_returned`} required inputMode="numeric" dir="ltr" />
              <label htmlFor={`rg-${p}-c`}>{c.t("ranking.g.complaints")}</label><input id={`rg-${p}-c`} name={`${p}_complaints`} required inputMode="numeric" dir="ltr" />
            </fieldset>
          ))}
          <label htmlFor="rg-mo">{c.t("ranking.g.minOrders")}</label><input id="rg-mo" name="min_orders" inputMode="numeric" dir="ltr" />
          <label htmlFor="rg-mr">{c.t("ranking.g.maxReturn")}</label><input id="rg-mr" name="max_return_bps" inputMode="numeric" dir="ltr" />
          <label htmlFor="rg-mc">{c.t("ranking.g.maxComplaint")}</label><input id="rg-mc" name="max_complaint_bps" inputMode="numeric" dir="ltr" />
          <button type="submit" className="btn primary" disabled={!writes}>{c.t("ranking.g.submit")}</button>
        </form>
      </section>
    </>
  );
}
