import { Badge, Empty, ErrorBlock, PageHeader } from "../../../components/ui";
import { formatMoney } from "../../../lib/format";
import { getConsole } from "../../../server/console";
import { approvalInbox } from "../../../view-models/approvals";
import { breakRows, trialBalance } from "../../../view-models/finance";
import type { Role } from "../../../view-models/common";

const LIMIT = 200;

export default async function FinancePage() {
  const c = await getConsole();
  const [bal, brk, apr] = await Promise.all([c.api.ledgerBalances(LIMIT), c.api.reconciliationBreaks(), c.api.approvals({ kind: "payout" })]);
  const tb = bal.ok ? trialBalance(bal.value.data.items, LIMIT) : null;
  const now = brk.ok ? (brk.value.serverNowMs ?? c.deviceNowMs) : c.deviceNowMs;
  const breaks = brk.ok ? breakRows(brk.value.data.items, now) : [];
  const payouts = apr.ok ? approvalInbox(apr.value.data.items.filter((a) => a.kind === "payout"), { nowMs: now, selfId: c.selfId ?? "", selfRoles: (c.roles ?? []) as readonly Role[] }) : null;
  return (
    <>
      <PageHeader title={c.t("finance.title")} intro={c.t("finance.intro")} />
      <h2>{c.t("finance.trialBalance")}</h2>
      {!bal.ok ? <ErrorBlock error={bal.error} c={c} /> : tb === null || tb.lines.length === 0 ? <Empty t={c.t} /> : (
        <div className="card">
          <p><Badge tone={tb.balanced ? (tb.complete ? "ok" : "warn") : "bad"}>
            {!tb.balanced ? c.t("finance.unbalanced") : tb.complete ? c.t("finance.balanced") : c.t("finance.balancedPartial")}</Badge></p>
          {!tb.complete ? <p className="muted">{c.t("finance.partialNote", { n: LIMIT })}</p> : null}
          <ul>{tb.lines.map((l) => <li key={l.currency}>{l.currency}: {formatMoney(l.sumMinor, c.locale)} ({l.accounts})</li>)}</ul>
        </div>
      )}
      <h2>{c.t("finance.tickets")}</h2>
      {!brk.ok ? <ErrorBlock error={brk.error} c={c} /> : breaks.length === 0 ? <Empty t={c.t} /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{c.t("col.kind")}</th><th>{c.t("col.reference")}</th><th>{c.t("col.difference")}</th><th>{c.t("col.age")}</th><th>{c.t("col.status")}</th></tr></thead>
          <tbody>{breaks.map((b) => (
            <tr key={b.id}><td>{b.kind}</td><td dir="ltr">{b.reference ?? ""}</td>
              <td>{b.differenceMinor === null ? "" : formatMoney(b.differenceMinor, c.locale)}</td>
              <td>{c.t("clock.left.days", { n: Math.floor(b.ageMs / 86_400_000) })}</td>
              <td><Badge tone={b.escalate ? "bad" : b.open ? "warn" : "ok"}>{b.escalate ? c.t("finance.escalate") : b.status}</Badge></td></tr>
          ))}</tbody>
        </table></div>
      )}
      <h2>{c.t("finance.payouts")}</h2>
      <p className="muted">{c.t("finance.payoutsNote")}</p>
      {payouts === null ? <ErrorBlock error={apr.ok ? { kind: "server" } : apr.error} c={c} /> : payouts.actionable.length + payouts.waiting.length === 0 ? <Empty t={c.t} /> : (
        <ul>{[...payouts.actionable, ...payouts.waiting].map((p) => (
          <li key={p.id} dir="ltr">{p.covers.subjectId} {p.covers.amountMinor === null ? "" : formatMoney(p.covers.amountMinor, c.locale)}</li>
        ))}</ul>
      )}
    </>
  );
}
