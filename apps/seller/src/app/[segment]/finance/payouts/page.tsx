import Link from "next/link";
import { createTranslator, localeSegment } from "@outlet/i18n";
import { PayoutsTable } from "../../../../components/finance/PayoutsTable";
import { PageFrame } from "../../../../components/PageFrame";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { PAYOUT_STATUSES, PayoutPage } from "../../../../lib/finance-model";
import { requireLocale, type SegmentParams } from "../../../../lib/segment-page";
import { sellerGet } from "../../../../server/seller-get";

const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

export default async function PayoutsPage({ params, searchParams }: { params: SegmentParams; searchParams: Promise<{ cursor?: string; status?: string }> }) {
  const resolved = await requireLocale(params);
  const sp = await searchParams;
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const status = PAYOUT_STATUSES.find((s) => s === sp.status);
  const cursor = sp.cursor !== undefined && CURSOR.test(sp.cursor) ? sp.cursor : undefined;
  const q = new URLSearchParams({ limit: "20" });
  if (status !== undefined) q.set("status", status);
  if (cursor !== undefined) q.set("cursor", cursor);
  const result = await sellerGet(resolved.marketId.toLowerCase(), `finance/payouts?${q.toString()}`);
  const page = result.ok ? PayoutPage.safeParse(result.data) : null;
  const keep = status === undefined ? "" : `status=${status}&`;
  return (
    <PageFrame resolved={resolved} current="payouts">
      <h1 className="pageTitle">{t("seller.finance.payouts.title")}</h1>
      <form className="filters" method="get" role="search" aria-label={t("seller.finance.payouts.filter.label")}>
        <div className="field">
          <label htmlFor="f-status">{t("seller.finance.payouts.filter.status")}</label>
          <select id="f-status" name="status" defaultValue={status ?? ""}>
            <option value="">{t("seller.finance.payouts.filter.all")}</option>
            {PAYOUT_STATUSES.map((s) => (
              <option key={s} value={s}>{t(`seller.finance.payouts.status.${s}`)}</option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btnPrimary">{t("seller.finance.payouts.filter.apply")}</button>
      </form>
      {!result.ok ? <ProblemBanner t={t} code={result.code} status={result.status} /> : null}
      {page?.success === true ? (
        <>
          <PayoutsTable locale={resolved.locale} base={base} rows={page.data.items} />
          {page.data.next_cursor === null ? null : (
            <p>
              <Link className="btnLink" href={`${base}/finance/payouts?${keep}cursor=${page.data.next_cursor}`}>{t("seller.finance.payouts.next")}</Link>
            </p>
          )}
        </>
      ) : null}
      {page?.success === false ? <ProblemBanner t={t} code="unknown" status={502} /> : null}
    </PageFrame>
  );
}
