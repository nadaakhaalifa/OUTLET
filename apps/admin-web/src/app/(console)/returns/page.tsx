import { Empty, ErrorBlock, PageHeader } from "../../../components/ui";
import { formatMoney } from "../../../lib/format";
import { getConsole } from "../../../server/console";
import { refundApprovals } from "../../../view-models/returns";

export default async function ReturnsPage() {
  const c = await getConsole();
  const r = await c.api.approvals({ kind: "refund" });
  const rows = r.ok ? refundApprovals(r.value.data.items) : [];
  return (
    <>
      <PageHeader title={c.t("returns.title")} intro={c.t("returns.intro")} />
      <p role="status" className="notice">{c.t("returns.gap")}</p>
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : rows.length === 0 ? <Empty t={c.t} /> : (
        <ul>{rows.map((x) => (
          <li key={x.id} dir="ltr">{x.subjectId} {x.amountMinor === null ? "" : formatMoney(x.amountMinor, c.locale)} {x.state}</li>
        ))}</ul>
      )}
    </>
  );
}
