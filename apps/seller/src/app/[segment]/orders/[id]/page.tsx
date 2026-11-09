import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { createTranslator, formatDate, formatMoney, localeSegment, type MessageKey } from "@outlet/i18n";
import { money } from "@outlet/money";
import { PageFrame } from "../../../../components/PageFrame";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { OrderActions } from "../../../../components/orders/OrderActions";
import { SlaCountdown } from "../../../../components/orders/SlaCountdown";
import { StatusChip } from "../../../../components/orders/StatusChip";
import { requireLocale } from "../../../../lib/segment-page";
import { slaKindOf } from "../../../../lib/sla";
import { SELLER_PII_ACCESS_DAYS } from "../../../../lib/policy-limits";
import { sellerGet } from "../../../../server/seller-get";

const Money = z.object({ amount_minor: z.string(), currency: z.literal("EGP") });
const Order = z.object({
  id: z.string(),
  status: z.string(),
  items_subtotal: Money, shipping: Money, vat: Money, commission: Money, total: Money,
  payment_kind: z.enum(["prepaid", "cod"]).nullable(),
  accept_by: z.string().nullable(),
  dispatch_by: z.string().nullable(),
  lines: z.array(z.object({ id: z.string(), title_ar_snapshot: z.string(), condition_grade_snapshot: z.string(), qty: z.number().int(), unit_price: Money })),
  delivery: z
    .object({
      recipient_name: z.string(),
      phone_masked: z.string(),
      address: z.object({ governorate_code: z.string(), city_code: z.string().nullable(), district_code: z.string().nullable(), street: z.string(), building: z.string(), floor: z.string().nullable(), apartment: z.string().nullable(), landmark: z.string().nullable() }),
      access_until: z.string().nullable(),
    })
    .nullable(),
  available_actions: z.array(z.string()),
  created_at: z.string(),
  server_time: z.string(),
});

type AddressField = "governorate_code" | "city_code" | "district_code" | "street" | "building" | "floor" | "apartment" | "landmark";
const ADDRESS_FIELDS: readonly (readonly [AddressField, MessageKey])[] = [
  ["governorate_code", "seller.orders.delivery.governorate"], ["city_code", "seller.orders.delivery.city"], ["district_code", "seller.orders.delivery.district"], ["street", "seller.orders.delivery.street"],
  ["building", "seller.orders.delivery.building"], ["floor", "seller.orders.delivery.floor"], ["apartment", "seller.orders.delivery.apartment"], ["landmark", "seller.orders.delivery.landmark"],
];

export default async function OrderPage({ params }: { params: Promise<{ segment: string; id: string }> }) {
  const resolved = await requireLocale(params);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const result = await sellerGet(resolved.marketId.toLowerCase(), `orders/${id}`);
  const parsed = result.ok ? Order.safeParse(result.data) : null;
  const o = parsed?.success === true ? parsed.data : null;
  const m = (v: { amount_minor: string }): string => formatMoney(money(BigInt(v.amount_minor), "EGP"), resolved.locale);
  const kind = o === null ? null : slaKindOf(o.status);
  const deadline = o === null ? null : kind === "accept" ? o.accept_by : kind === "dispatch" ? o.dispatch_by : null;
  return (
    <PageFrame resolved={resolved} current="orders">
      <p>
        <Link href={`${base}/orders`}>{t("seller.orders.detail.back")}</Link>
      </p>
      {!result.ok ? <ProblemBanner t={t} code={result.code} status={result.status} /> : null}
      {o === null ? null : (
        <>
          <div className="titleRow">
            <h1 className="pageTitle">{t("seller.orders.detail.title", { id: o.id.slice(0, 8) })}</h1>
            <StatusChip t={t} status={o.status} />
          </div>
          {kind !== null && deadline !== null ? (
            <p>
              <SlaCountdown locale={resolved.locale} kind={kind} deadline={deadline} serverTime={o.server_time} />
            </p>
          ) : null}
          <p className="hint">{formatDate(new Date(o.created_at), resolved.locale, { style: "long" })}</p>

          <OrderActions locale={resolved.locale} marketId={resolved.marketId} orderId={o.id} actions={o.available_actions} status={o.status} />

          <section aria-labelledby="lines-h">
            <h2 id="lines-h" className="panelTitle">
              {t("seller.orders.detail.lines")}
            </h2>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("seller.orders.detail.col.item")}</th>
                  <th scope="col">{t("seller.orders.detail.col.condition")}</th>
                  <th scope="col">{t("seller.orders.detail.col.qty")}</th>
                  <th scope="col">{t("seller.orders.detail.col.unit")}</th>
                </tr>
              </thead>
              <tbody>
                {o.lines.map((l) => (
                  <tr key={l.id}>
                    <th scope="row">{l.title_ar_snapshot}</th>
                    <td>{l.condition_grade_snapshot}</td>
                    <td>{l.qty}</td>
                    <td>{m(l.unit_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section aria-labelledby="amounts-h">
            <h2 id="amounts-h" className="panelTitle">
              {t("seller.orders.detail.totals")}
            </h2>
            <dl className="facts">
              <dt>{t("seller.orders.detail.items")}</dt>
              <dd>{m(o.items_subtotal)}</dd>
              <dt>{t("seller.orders.detail.shipping")}</dt>
              <dd>{m(o.shipping)}</dd>
              <dt>{t("seller.orders.detail.vat")}</dt>
              <dd>{m(o.vat)}</dd>
              <dt>{t("seller.orders.detail.commission")}</dt>
              <dd>{m(o.commission)}</dd>
              <dt>{t("seller.orders.detail.total")}</dt>
              <dd>{m(o.total)}</dd>
              <dt>{t("seller.orders.detail.payment")}</dt>
              <dd>{t(o.payment_kind === "cod" ? "seller.orders.paymentKind.cod" : o.payment_kind === "prepaid" ? "seller.orders.paymentKind.prepaid" : "seller.orders.paymentKind.unknown")}</dd>
            </dl>
          </section>

          <section aria-labelledby="delivery-h">
            <h2 id="delivery-h" className="panelTitle">
              {t("seller.orders.delivery.title")}
            </h2>
            {o.delivery === null ? (
              <p className="hint">{t("seller.orders.delivery.hidden")}</p>
            ) : (
              <>
                <dl className="facts">
                  <dt>{t("seller.orders.delivery.name")}</dt>
                  <dd>{o.delivery.recipient_name}</dd>
                  <dt>{t("seller.orders.delivery.phone")}</dt>
                  <dd dir="ltr">{o.delivery.phone_masked}</dd>
                  {ADDRESS_FIELDS.map(([field, label]) => {
                    const v = o.delivery?.address[field];
                    return v === null || v === undefined ? null : (
                      <div key={field} className="factRow">
                        <dt>{t(label)}</dt>
                        <dd>{v}</dd>
                      </div>
                    );
                  })}
                </dl>
                <p className="hint">
                  {o.delivery.access_until === null ? t("seller.orders.delivery.live", { days: SELLER_PII_ACCESS_DAYS }) : t("seller.orders.delivery.until", { date: formatDate(new Date(o.delivery.access_until), resolved.locale, { style: "long" }) })}
                </p>
              </>
            )}
          </section>
        </>
      )}
    </PageFrame>
  );
}
