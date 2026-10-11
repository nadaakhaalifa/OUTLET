import { Badge, Empty, ErrorBlock, Flash, PageHeader, WritesDisabledNote } from "../../../components/ui";
import { formatDateTime, formatMoney } from "../../../lib/format";
import { approveAction, rejectAction } from "../../../server/actions";
import { getConsole } from "../../../server/console";
import { approvalInbox, type ApprovalRow } from "../../../view-models/approvals";
import type { Role } from "../../../view-models/common";

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const r = await c.api.approvals();
  const now = r.ok ? (r.value.serverNowMs ?? c.deviceNowMs) : c.deviceNowMs;
  const inbox = r.ok ? approvalInbox(r.value.data.items, { nowMs: now, selfId: c.selfId ?? "", selfRoles: (c.roles ?? []) as readonly Role[] }) : null;
  const writes = c.posture.sensitiveWritesEnabled;

  const table = (rows: readonly ApprovalRow[], withActions: boolean) => (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{c.t("col.kind")}</th><th>{c.t("col.covers")}</th><th>{c.t("col.amount")}</th>
            <th>{c.t("col.expires")}</th><th>{c.t("col.status")}</th>{withActions ? <th>{c.t("col.actions")}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td>{c.t(a.kindKey)}</td>
              <td dir="ltr">
                <code>{a.covers.kind}:{a.covers.subjectType}:{a.covers.subjectId}</code>
                <div className="muted">{c.t("approval.coversHelp")}</div>
                {a.coversNow ? <Badge tone="ok">{c.t("approval.coversNow")}</Badge> : null}
              </td>
              <td>{a.covers.amountMinor === null ? c.t("approval.noAmount") : formatMoney(a.covers.amountMinor, c.locale)}</td>
              <td>{formatDateTime(new Date(a.expiresAtMs).toISOString(), c.locale)}</td>
              <td>
                <Badge tone={a.effectiveState === "APPROVED" ? "ok" : a.effectiveState === "REQUESTED" ? "warn" : "bad"}>{a.effectiveState}</Badge>
                {a.blocked === null ? null : <div className="muted">{c.t(`approval.blocked.${a.blocked}`)}</div>}
              </td>
              {withActions ? (
                <td>
                  <div className="row">
                    <form action={approveAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <button className="btn primary" type="submit" disabled={!a.canApprove || !writes}>{c.t("act.approve")}</button>
                    </form>
                    <form action={rejectAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <button className="btn" type="submit" disabled={!a.canReject || !writes}>{c.t("act.reject")}</button>
                    </form>
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <PageHeader title={c.t("approvals.title")} intro={c.t("approvals.intro")} />
      <Flash code={sp.r} t={c.t} />
      <WritesDisabledNote c={c} />
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : null}
      {inbox === null ? null : (
        <>
          <h2>{c.t("approvals.actionable")}</h2>
          {inbox.actionable.length === 0 ? <Empty t={c.t} /> : table(inbox.actionable, true)}
          <h2>{c.t("approvals.waiting")}</h2>
          {inbox.waiting.length === 0 ? <Empty t={c.t} /> : table(inbox.waiting, true)}
          <h2>{c.t("approvals.decided")}</h2>
          {inbox.decided.length === 0 ? <Empty t={c.t} /> : table(inbox.decided, false)}
        </>
      )}
    </>
  );
}
