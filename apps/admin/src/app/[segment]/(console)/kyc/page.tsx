import { createTranslator, localeSegment } from "@outlet/i18n";
import { ConsoleFrame } from "../../../../components/ConsoleFrame";
import { KycQueue } from "../../../../components/KycQueue";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { load } from "../../../../lib/load";
import { KycSummaryPage } from "../../../../lib/schemas";
import { requireLocale, type SegmentParams } from "../../../../lib/segment-page";

export default async function KycPage({ params, searchParams }: { params: SegmentParams; searchParams: Promise<{ status?: string }> }) {
  const resolved = await requireLocale(params);
  const { status = "" } = await searchParams;
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const res = await load(KycSummaryPage, resolved.marketId, "kyc-cases", { status });
  return (
    <ConsoleFrame resolved={resolved} section="kyc">
      <h1 className="pageTitle">{t("admin.kyc.title")}</h1>
      <p className="lead">{t("admin.kyc.lead")}</p>
      {res.ok ? <KycQueue t={t} locale={resolved.locale} base={base} items={res.data.items} status={status} /> : <ProblemBanner t={t} code={res.code} status={res.status} />}
    </ConsoleFrame>
  );
}
