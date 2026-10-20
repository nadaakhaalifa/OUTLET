import { Badge, Empty, ErrorBlock, PageHeader } from "../../../components/ui";
import { formatDateTime, formatMoney } from "../../../lib/format";
import { getConsole } from "../../../server/console";
import { promotionRows } from "../../../view-models/queues";

export default async function PromotionsPage() {
  const c = await getConsole();
  const r = await c.api.promotions();
  const rows = r.ok ? promotionRows(r.value.data.items) : [];
  return (
    <>
      <PageHeader title={c.t("promotions.title")} intro={c.t("promotions.intro")} />
      {!r.ok ? <ErrorBlock error={r.error} c={c} /> : rows.length === 0 ? <Empty t={c.t} /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>{c.t("col.title")}</th><th>{c.t("col.type")}</th><th>{c.t("col.funding")}</th><th>{c.t("col.budget")}</th><th>{c.t("col.window")}</th><th>{c.t("col.status")}</th></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id}><td>{c.locale === "ar" ? p.titleAr : (p.titleEn ?? p.titleAr)}{p.code === null ? null : <div dir="ltr" className="muted">{p.code}</div>}</td>
              <td>{p.type}</td>
              <td>{p.platformPct}% / {p.sellerPct}%{p.fundingOk ? null : <Badge tone="bad">{c.t("promotions.fundingMismatch")}</Badge>}</td>
              <td>{p.budgetMinor === null ? c.t("common.none") : formatMoney(p.budgetMinor, c.locale)}</td>
              <td>{formatDateTime(new Date(p.startsAtMs).toISOString(), c.locale)} – {formatDateTime(new Date(p.endsAtMs).toISOString(), c.locale)}</td>
              <td><Badge tone={p.status === "active" ? "ok" : "neutral"}>{p.status}</Badge></td></tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
