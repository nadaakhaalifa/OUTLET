import { createTranslator } from "@outlet/i18n";
import { ConsoleFrame } from "../../../../components/ConsoleFrame";
import { DlqQueue } from "../../../../components/DlqQueue";
import { PageHeader } from "../../../../components/kit/PageHeader";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { DlqPage } from "../../../../lib/dlq";
import { load } from "../../../../lib/load";
import { requireLocale, type SegmentParams } from "../../../../lib/segment-page";
import { currentProfile } from "../../../../server/admin-get";
import { can } from "../../../../server/session";

export default async function DlqRoute({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const profile = await currentProfile();
  const res = await load(DlqPage, resolved.marketId, "dlq", { limit: "50" });
  return (
    <ConsoleFrame resolved={resolved} section="dlq">
      <PageHeader title={t("admin.dlq.title")} description={t("admin.dlq.lead")} />
      {res.ok
        ? <DlqQueue locale={resolved.locale} market={resolved.marketId} items={res.data.items} now={new Date().toISOString()} canManage={profile !== null && can(profile, "dlq.manage")} />
        : <ProblemBanner t={t} code={res.code} status={res.status} />}
    </ConsoleFrame>
  );
}
