import { notFound } from "next/navigation";
import { createTranslator, localeSegment } from "@outlet/i18n";
import { PayoutDetailView } from "../../../../../components/finance/PayoutDetailView";
import { PageFrame } from "../../../../../components/PageFrame";
import { ProblemBanner } from "../../../../../components/ProblemBanner";
import { PayoutDetail } from "../../../../../lib/finance-model";
import { requireLocale } from "../../../../../lib/segment-page";
import { sellerGet } from "../../../../../server/seller-get";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PayoutPage({ params }: { params: Promise<{ segment: string; id: string }> }) {
  const { id } = await params;
  const resolved = await requireLocale(params);
  if (!UUID.test(id)) notFound();
  const t = createTranslator(resolved.locale);
  const result = await sellerGet(resolved.marketId.toLowerCase(), `finance/payouts/${id}`);
  if (!result.ok && result.status === 404) notFound();
  const parsed = result.ok ? PayoutDetail.safeParse(result.data) : null;
  return (
    <PageFrame resolved={resolved} current="payouts">
      <h1 className="pageTitle">{t("seller.finance.payout.title", { id: id.slice(0, 8) })}</h1>
      {!result.ok ? <ProblemBanner t={t} code={result.code} status={result.status} /> : null}
      {parsed?.success === true ? <PayoutDetailView locale={resolved.locale} base={`/${localeSegment(resolved.marketId, resolved.locale)}`} payout={parsed.data} /> : null}
      {parsed?.success === false ? <ProblemBanner t={t} code="unknown" status={502} /> : null}
    </PageFrame>
  );
}
