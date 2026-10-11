import { Badge, Empty, ErrorBlock, Flash, PageHeader, clockText } from "../../../components/ui";
import { formatDateTime } from "../../../lib/format";
import { breachStepAction, breachTriageAction } from "../../../server/actions";
import { getConsole } from "../../../server/console";
import { breachRegister, dsarQueueRows } from "../../../view-models/privacy";

export default async function PrivacyPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const [q, b] = await Promise.all([c.api.dsarQueue(), c.api.breaches()]);
  const now = q.ok ? (q.value.serverNowMs ?? c.deviceNowMs) : b.ok ? (b.value.serverNowMs ?? c.deviceNowMs) : c.deviceNowMs;
  const dsar = q.ok ? dsarQueueRows(q.value.data.items, now) : [];
  const breaches = b.ok ? breachRegister(b.value.data.items, now) : [];
  return (
    <>
      <PageHeader title={c.t("privacy.title")} intro={c.t("privacy.intro")} />
      <Flash code={sp.r} t={c.t} />
      <h2>{c.t("privacy.dsar")}</h2>
      {!q.ok ? <ErrorBlock error={q.error} c={c} /> : dsar.length === 0 ? <Empty t={c.t} /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{c.t("col.type")}</th><th>{c.t("col.subject")}</th><th>{c.t("col.due")}</th><th>{c.t("col.clock")}</th><th>{c.t("col.status")}</th></tr></thead>
          <tbody>{dsar.map((d) => (
            <tr key={d.id}><td>{d.kind}</td><td dir="ltr">{d.subjectRef}</td>
              <td>{formatDateTime(new Date(d.dueAtMs).toISOString(), c.locale)}</td>
              <td><Badge tone={d.overdue ? "bad" : "neutral"}>{clockText(d.clock, c.t)}</Badge></td>
              <td>{d.status}{d.blockers.length > 0 ? ` (${d.blockers.join(", ")})` : ""}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      <h2>{c.t("privacy.breaches")}</h2>
      <p className="muted">{c.t("privacy.clocksNote")}</p>
      {!b.ok ? <ErrorBlock error={b.error} c={c} /> : breaches.length === 0 ? <Empty t={c.t} /> : breaches.map((x) => (
        <article key={x.id} className="card">
          <h3>{x.summary}</h3>
          <p className="muted">{x.severity} · {c.t("privacy.affected", { n: x.affected })}</p>
          <ul>{x.clocks.filter((k) => k.required).map((k) => (
            <li key={k.label}>{c.t(`privacy.clock.${k.label}`)}:{" "}
              {k.met ? <Badge tone={k.metLate ? "bad" : "ok"}>{k.metLate ? c.t("privacy.metLate") : c.t("privacy.met")}</Badge>
                : k.clock === null ? <Badge tone="neutral">{c.t("privacy.notStarted")}</Badge>
                : <Badge tone={k.overdue ? "bad" : "warn"}>{clockText(k.clock, c.t)}</Badge>}</li>
          ))}</ul>
          {x.nextStep === "done" ? <Badge tone="ok">{c.t("privacy.closed")}</Badge> : x.nextStep === "triage" ? (
            <div className="row">
              <form action={breachTriageAction}><input type="hidden" name="id" value={x.id} /><input type="hidden" name="decision" value="notify" />
                <button className="btn primary" type="submit">{c.t("act.triageNotify")}</button></form>
              <form action={breachTriageAction}><input type="hidden" name="id" value={x.id} /><input type="hidden" name="decision" value="no_notification_required" />
                <button className="btn" type="submit">{c.t("act.triageNone")}</button></form>
            </div>
          ) : (
            <form action={breachStepAction}><input type="hidden" name="id" value={x.id} /><input type="hidden" name="step" value={x.nextStep} />
              <button className="btn primary" type="submit">{c.t(`act.step.${x.nextStep}`)}</button></form>
          )}
        </article>
      ))}
    </>
  );
}
