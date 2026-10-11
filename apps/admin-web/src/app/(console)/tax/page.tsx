import { Badge, Empty, ErrorBlock, Flash, PageHeader } from "../../../components/ui";
import { formatInt, formatMoney } from "../../../lib/format";
import { requeueAction } from "../../../server/actions";
import { getConsole } from "../../../server/console";
import { previousCairoDate, reconciliationView, submissionBoard } from "../../../view-models/tax";

export default async function TaxPage({ searchParams }: { searchParams: Promise<{ r?: string; date?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const date = sp.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : previousCairoDate(c.deviceNowMs);
  const [docs, rec] = await Promise.all([c.api.taxDocuments(), c.api.taxReconciliation(date)]);
  const board = docs.ok ? submissionBoard(docs.value.data.items) : null;
  const rv = rec.ok ? reconciliationView(rec.value.data) : null;
  const writes = c.posture.sensitiveWritesEnabled;
  return (
    <>
      <PageHeader title={c.t("tax.title")} intro={c.t("tax.intro")} />
      <Flash code={sp.r} t={c.t} />
      <h2>{c.t("tax.reconciliation")} <span dir="ltr">{date}</span></h2>
      {!rec.ok ? <ErrorBlock error={rec.error} c={c} /> : rv === null ? null : rv.empty ? <Empty t={c.t} messageKey="tax.noDocuments" /> : (
        <div className="card">
          <p><Badge tone={rv.clean ? "ok" : "bad"}>{rv.clean ? c.t("tax.clean") : c.t("tax.discrepancies", { n: rv.discrepancyCount })}</Badge></p>
          <dl>
            <div className="kv"><dt>{c.t("tax.documents")}</dt><dd>{formatInt(rv.documents, c.locale)}</dd></div>
            <div className="kv"><dt>{c.t("tax.accepted")}</dt><dd>{formatInt(rv.accepted, c.locale)}</dd></div>
            <div className="kv"><dt>{c.t("tax.rejected")}</dt><dd>{formatInt(rv.rejected, c.locale)}</dd></div>
          </dl>
          {rv.discrepancies.length > 0 ? <ul>{rv.discrepancies.map((d) => <li key={d.internalId} dir="ltr">{d.internalId}: {d.kind}</li>)}</ul> : null}
        </div>
      )}
      <h2>{c.t("tax.queue")}</h2>
      {!docs.ok ? <ErrorBlock error={docs.error} c={c} /> : board === null || board.rows.length === 0 ? <Empty t={c.t} /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{c.t("col.kind")}</th><th>{c.t("col.reference")}</th><th>{c.t("col.status")}</th><th>{c.t("col.attempts")}</th><th>{c.t("col.amount")}</th><th>{c.t("col.actions")}</th></tr></thead>
          <tbody>{board.rows.map((d) => (
            <tr key={d.id}><td>{d.kind}</td><td dir="ltr">{d.sourceRef}</td>
              <td><Badge tone={d.needsAttention ? "bad" : d.state === "ACCEPTED" ? "ok" : "neutral"}>{d.state}</Badge>
                {d.lastError === null ? null : <div className="muted" dir="ltr">{d.lastError}</div>}</td>
              <td>{d.attempts}/{d.maxAttempts}</td>
              <td>{d.grossMinor === null ? "" : formatMoney(d.grossMinor, c.locale)}</td>
              <td>{d.canRequeue ? (
                <form action={requeueAction}><input type="hidden" name="id" value={d.id} />
                  <button className="btn" type="submit" disabled={!writes}>{c.t("act.requeue")}</button></form>
              ) : null}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
