import Link from "next/link";
import { z } from "zod";
import { createTranslator, formatDate, formatMoney, localeSegment } from "@outlet/i18n";
import { money } from "@outlet/money";
import { PageFrame } from "../../../components/PageFrame";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { SlaCountdown } from "../../../components/orders/SlaCountdown";
import { StatusChip } from "../../../components/orders/StatusChip";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";
import { slaKindOf } from "../../../lib/sla";
import { sellerGet } from "../../../server/seller-get";

const Page = z.object({
  items: z.array(z.object({ id: z.string(), status: z.string(), total: z.object({ amount_minor: z.string(), currency: z.literal("EGP") }), accept_by: z.string().nullable(), dispatch_by: z.string().nullable(), created_at: z.string() })),
  next_cursor: z.string().nullable(),
  server_time: z.string(),
});

const FILTER_STATUSES = ["PAID", "CONFIRMED_COD", "ACCEPTED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED", "REJECTED_BY_SELLER"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUS = /^[A-Z_]{3,40}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

interface Search {
  cursor?: string;
  status?: string;
  from?: string;
  to?: string;
}

export default async function OrdersPage({ params, searchParams }: { params: SegmentParams; searchParams: Promise<Search> }) {
  const resolved = await requireLocale(params);
  const sp = await searchParams;
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const status = sp.status !== undefined && STATUS.test(sp.status) ? sp.status : undefined;
  const from = sp.from !== undefined && DATE.test(sp.from) ? sp.from : undefined;
  const to = sp.to !== undefined && DATE.test(sp.to) ? sp.to : undefined;
  const cursor = sp.cursor !== undefined && CURSOR.test(sp.cursor) ? sp.cursor : undefined;
  const q = new URLSearchParams({ limit: "20" });
  if (status !== undefined) q.set("status", status);
  if (from !== undefined) q.set("from", `${from}T00:00:00.000Z`);
  if (to !== undefined) q.set("to", `${to}T23:59:59.999Z`);
  if (cursor !== undefined) q.set("cursor", cursor);
  const result = await sellerGet(resolved.marketId.toLowerCase(), `orders?${q.toString()}`);
  const page = result.ok ? Page.safeParse(result.data) : null;
  const keep = new URLSearchParams();
  if (status !== undefined) keep.set("status", status);
  if (from !== undefined) keep.set("from", from);
  if (to !== undefined) keep.set("to", to);
  const filtered = keep.size > 0;
  return (
    <PageFrame resolved={resolved} current="orders">
      <h1 className="pageTitle">{t("seller.orders.title")}</h1>
      <form className="filters" method="get" role="search" aria-label={t("seller.orders.filter.label")}>
        <div className="field">
          <label htmlFor="f-status">{t("seller.orders.filter.status")}</label>
          <select id="f-status" name="status" defaultValue={status ?? ""}>
            <option value="">{t("seller.orders.filter.all")}</option>
            {FILTER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`seller.orders.status.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-from">{t("seller.orders.filter.from")}</label>
          <input id="f-from" name="from" type="date" defaultValue={from ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="f-to">{t("seller.orders.filter.to")}</label>
          <input id="f-to" name="to" type="date" defaultValue={to ?? ""} />
        </div>
        <button type="submit" className="btn btnPrimary">
          {t("seller.orders.filter.apply")}
        </button>
        {filtered ? (
          <Link className="btn btnGhost" href={`${base}/orders`}>
            {t("seller.orders.filter.clear")}
          </Link>
        ) : null}
      </form>
      {!result.ok ? <ProblemBanner t={t} code={result.code} status={result.status} /> : null}
      {page?.success === true && page.data.items.length === 0 ? <p className="empty">{t("seller.orders.empty")}</p> : null}
      {page?.success === true && page.data.items.length > 0 ? (
        <>
          <table className="table">
            <caption className="srOnly">{t("seller.orders.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("seller.orders.col.order")}</th>
                <th scope="col">{t("seller.orders.col.status")}</th>
                <th scope="col">{t("seller.orders.col.deadline")}</th>
                <th scope="col">{t("seller.orders.col.total")}</th>
                <th scope="col">{t("seller.orders.col.created")}</th>
              </tr>
            </thead>
            <tbody>
              {page.data.items.map((o) => {
                const kind = slaKindOf(o.status);
                const deadline = kind === "accept" ? o.accept_by : kind === "dispatch" ? o.dispatch_by : null;
                return (
                  <tr key={o.id}>
                    <th scope="row">
                      <Link href={`${base}/orders/${o.id}`} dir="ltr">
                        {o.id.slice(0, 8)}
                      </Link>
                    </th>
                    <td>
                      <StatusChip t={t} status={o.status} />
                    </td>
                    <td>{kind !== null && deadline !== null ? <SlaCountdown locale={resolved.locale} kind={kind} deadline={deadline} serverTime={page.data.server_time} /> : t("seller.orders.sla.none")}</td>
                    <td>{formatMoney(money(BigInt(o.total.amount_minor), "EGP"), resolved.locale)}</td>
                    <td>{formatDate(new Date(o.created_at), resolved.locale, { style: "medium" })}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {page.data.next_cursor === null ? null : (
            <p>
              <Link className="btnLink" href={`${base}/orders?${new URLSearchParams({ ...Object.fromEntries(keep), cursor: page.data.next_cursor }).toString()}`}>
                {t("seller.orders.next")}
              </Link>
            </p>
          )}
        </>
      ) : null}
    </PageFrame>
  );
}
