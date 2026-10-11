import { Badge, Empty, ErrorBlock, PageHeader } from "../../../components/ui";
import { formatDateTime } from "../../../lib/format";
import { getConsole } from "../../../server/console";
import { priceMonitor } from "../../../view-models/queues";

export default async function PriceIntegrityPage() {
  const c = await getConsole();
  const r = await c.api.priceActions();
  const now = r.ok ? (r.value.serverNowMs ?? c.deviceNowMs) : c.deviceNowMs;
  const m = r.ok ? priceMonitor(r.value.data.items, now) : null;
  return (
    <>
      <PageHeader title={c.t("price.title")} intro={c.t("price.intro")} />
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : null}
      {m === null ? null : (
        <>
          <h2>{c.t("price.appeals")}</h2>
          <p className="muted">{c.t("price.appealsNote")}</p>
          {m.appeals.length === 0 ? <Empty t={c.t} /> : (
            <ul>{m.appeals.map((a) => (
              <li key={a.id}><span dir="ltr">{a.storeId}</span> {a.action} {a.reviewOverdue ? <Badge tone="bad">{c.t("state.overdue")}</Badge> : null}</li>
            ))}</ul>
          )}
          <h2>{c.t("price.log")}</h2>
          {m.log.length === 0 ? <Empty t={c.t} /> : (
            <div className="table-wrap"><table>
              <thead><tr><th>{c.t("col.store")}</th><th>{c.t("col.action")}</th><th>{c.t("col.reason")}</th><th>{c.t("col.evidence")}</th><th>{c.t("col.applied")}</th></tr></thead>
              <tbody>{m.log.map((a) => (
                <tr key={a.id}><td dir="ltr">{a.storeId}</td><td>{a.action}</td><td>{a.reasonCode}</td><td>{a.evidenceCount}</td>
                  <td>{formatDateTime(new Date(a.appliedAtMs).toISOString(), c.locale)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </>
      )}
    </>
  );
}
