import Link from "next/link";
import { notFound } from "next/navigation";
import { createTranslator, localeSegment } from "@outlet/i18n";
import { ConsoleFrame } from "../../../../../components/ConsoleFrame";
import { KycCasePanel } from "../../../../../components/KycCasePanel";
import { ProblemBanner } from "../../../../../components/ProblemBanner";
import { load } from "../../../../../lib/load";
import { KycCase } from "../../../../../lib/schemas";
import { requireLocale, type SegmentParams } from "../../../../../lib/segment-page";
import { currentProfile } from "../../../../../server/admin-get";
import { can } from "../../../../../server/session";

export default async function KycCasePage({ params }: { params: SegmentParams & Promise<{ id: string }> }) {
  const resolved = await requireLocale(params);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const profile = await currentProfile();
  const res = await load(KycCase, resolved.marketId, `kyc-cases/${id}`);
  return (
    <ConsoleFrame resolved={resolved} section="kyc">
      <h1 className="pageTitle">{t("admin.kyc.case.title")}</h1>
      <p><Link href={`${base}/kyc`}>{t("admin.kyc.case.back")}</Link></p>
      {res.ok ? <KycCasePanel locale={resolved.locale} market={resolved.marketId} data={res.data} canDecide={profile !== null && can(profile, "seller_kyc.review")} /> : <ProblemBanner t={t} code={res.code} status={res.status} />}
    </ConsoleFrame>
  );
}
