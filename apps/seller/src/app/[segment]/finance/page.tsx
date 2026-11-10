import { createTranslator, localeSegment } from "@outlet/i18n";
import { BalanceOverview } from "../../../components/finance/BalanceOverview";
import { PageFrame } from "../../../components/PageFrame";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { Balance } from "../../../lib/finance-model";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";
import { sellerGet } from "../../../server/seller-get";

export default async function BalancePage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const result = await sellerGet(resolved.marketId.toLowerCase(), "finance/balance");
  const parsed = result.ok ? Balance.safeParse(result.data) : null;
  return (
    <PageFrame resolved={resolved} current="finance">
      <h1 className="pageTitle">{t("seller.finance.balance.title")}</h1>
      {!result.ok ? <ProblemBanner t={t} code={result.code} status={result.status} /> : null}
      {parsed?.success === true ? <BalanceOverview locale={resolved.locale} base={`/${localeSegment(resolved.marketId, resolved.locale)}`} balance={parsed.data} /> : null}
      {parsed?.success === false ? <ProblemBanner t={t} code="unknown" status={502} /> : null}
    </PageFrame>
  );
}
