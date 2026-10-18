import { Badge, Empty, ErrorBlock, Flash, PageHeader, clockText } from "../../../components/ui";
import { ReasonDialog } from "../../../components/reason-dialog";
import { formatDateTime } from "../../../lib/format";
import { reinstateFromReviewAction, upholdReviewAction } from "../../../server/actions";
import { getConsole } from "../../../server/console";
import { ORDINARY_REASON_CODES } from "../../../view-models/common";
import { reviewQueue } from "../../../view-models/kyc";
import { meterClass } from "../../../view-models/meter";

export default async function SuspensionsPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const r = await c.api.suspensionReviews();
  const now = r.ok ? (r.value.serverNowMs ?? c.deviceNowMs) : c.deviceNowMs;
  const rows = r.ok ? reviewQueue(r.value.data.items, now) : [];
  const reasons = ORDINARY_REASON_CODES.map((x) => ({ code: x.code, label: c.t(x.labelKey) }));
  return (
    <>
      <PageHeader title={c.t("suspensions.title")} intro={c.t("suspensions.intro")} />
      <Flash code={sp.r} t={c.t} />
      <p className="muted">{c.t("suspensions.suspenderNote")}</p>
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : rows.length === 0 ? <Empty t={c.t} /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{c.t("col.seller")}</th><th>{c.t("col.due")}</th><th>{c.t("col.clock")}</th><th>{c.t("col.status")}</th><th>{c.t("col.actions")}</th></tr></thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td dir="ltr">{v.sellerId}{v.automatic ? <Badge tone="warn">{c.t("suspensions.automatic")}</Badge> : null}</td>
                  <td>{formatDateTime(new Date(v.dueAtMs).toISOString(), c.locale)}</td>
                  <td>
                    {v.clock === null ? null : <Badge tone={v.overdue ? "bad" : "neutral"}>{clockText(v.clock, c.t)}</Badge>}
                    <span className={v.overdue ? "meter late" : "meter"} aria-hidden="true"><span className={meterClass(v.elapsed)} /></span>
                  </td>
                  <td><Badge tone={v.state === "OPEN" ? "warn" : "neutral"}>{v.state}</Badge></td>
                  <td className="row">
                    <form action={upholdReviewAction}><input type="hidden" name="id" value={v.id} />
                      <button className="btn" type="submit" disabled={!v.canDecide}>{c.t("act.uphold")}</button></form>
                    <ReasonDialog triggerLabel={c.t("act.reinstate")} title={c.t("sellers.reinstateTitle")} reasonLabel={c.t("common.reason")}
                      choosePlaceholder={c.t("common.choose")} submitLabel={c.t("act.reinstate")} cancelLabel={c.t("common.cancel")}
                      reasons={reasons} action={reinstateFromReviewAction} hidden={{ seller_id: v.sellerId }} disabled={!v.canDecide} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
