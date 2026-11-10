import { createTranslator } from "@outlet/i18n";
import { AttentionQueue } from "../../../../components/home/AttentionQueue";
import { ConsoleFrame } from "../../../../components/ConsoleFrame";
import { PageHeader } from "../../../../components/kit/PageHeader";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { AttentionPage } from "../../../../lib/attention";
import { load } from "../../../../lib/load";
import { requireLocale, type SegmentParams } from "../../../../lib/segment-page";
import { currentProfile } from "../../../../server/admin-get";
import { can } from "../../../../server/session";

export default async function AttentionRoute({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const profile = await currentProfile();
  const res = await load(AttentionPage, resolved.marketId, "attention");
  return (
    <ConsoleFrame resolved={resolved} section="attention">
      <PageHeader title={t("admin.attention.title")} description={t("admin.attention.lead")} />
      {res.ok
        ? <AttentionQueue locale={resolved.locale} market={resolved.marketId} items={res.data.items} canWrite={profile !== null && can(profile, "attention.write")} />
        : <ProblemBanner t={t} code={res.code} status={res.status} />}
    </ConsoleFrame>
  );
}
