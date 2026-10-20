import { Badge, Empty, ErrorBlock, Flash, PageHeader } from "../../../components/ui";
import { ReasonDialog } from "../../../components/reason-dialog";
import { reinstateSellerAction, suspendSellerAction } from "../../../server/actions";
import { getConsole } from "../../../server/console";
import { ORDINARY_REASON_CODES } from "../../../view-models/common";
import { sellerQueue } from "../../../view-models/kyc";

export default async function SellersPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const r = await c.api.kycQueue();
  const rows = r.ok ? sellerQueue(r.value.data.items) : [];
  const reasons = ORDINARY_REASON_CODES.map((x) => ({ code: x.code, label: c.t(x.labelKey) }));
  const common = {
    reasonLabel: c.t("common.reason"), choosePlaceholder: c.t("common.choose"), cancelLabel: c.t("common.cancel"), reasons,
  };
  return (
    <>
      <PageHeader title={c.t("sellers.title")} intro={c.t("sellers.intro")} />
      <Flash code={sp.r} t={c.t} />
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : rows.length === 0 ? <Empty t={c.t} /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{c.t("col.stores")}</th><th>{c.t("col.state")}</th><th>{c.t("col.actions")}</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.sellerId}>
                  <td>{s.storeNames.join("، ") || s.sellerId}</td>
                  <td><Badge tone={s.state === "SUSPENDED" ? "bad" : s.inQueue ? "warn" : "ok"}>{s.state}</Badge></td>
                  <td>
                    <div className="row">
                      <ReasonDialog {...common} triggerLabel={c.t("act.suspend")} title={c.t("sellers.suspendTitle")}
                        description={c.t("sellers.reviewClock")} submitLabel={c.t("act.suspend")} action={suspendSellerAction}
                        hidden={{ id: s.sellerId }} danger disabled={!s.canSuspend} />
                      <ReasonDialog {...common} triggerLabel={c.t("act.reinstate")} title={c.t("sellers.reinstateTitle")}
                        submitLabel={c.t("act.reinstate")} action={reinstateSellerAction} hidden={{ id: s.sellerId }} disabled={!s.canReinstate} />
                    </div>
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
