import { createTranslator } from "@outlet/i18n";
import { ConsoleFrame } from "../../../../components/ConsoleFrame";
import { ElevationPanel } from "../../../../components/ElevationPanel";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { load } from "../../../../lib/load";
import { ApprovalPage } from "../../../../lib/schemas";
import { requireLocale, type SegmentParams } from "../../../../lib/segment-page";
import { currentProfile } from "../../../../server/admin-get";

export default async function AccessPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const profile = await currentProfile();
  const res = await load(ApprovalPage, resolved.marketId, "approval-requests");
  // The approval list is role-limited (finance, security, dpo, super_admin); anyone else can still file a request.
  const canDecide = profile?.roles.some((r) => ["finance", "security", "dpo", "super_admin"].includes(r)) === true;
  return (
    <ConsoleFrame resolved={resolved} section="access">
      <h1 className="pageTitle">{t("admin.access.title")}</h1>
      <p className="lead">{t("admin.access.lead")}</p>
      {!res.ok && res.status !== 403 ? <ProblemBanner t={t} code={res.code} status={res.status} /> : null}
      <ElevationPanel locale={resolved.locale} market={resolved.marketId} requests={res.ok ? res.data.items : []} canDecide={canDecide && res.ok} selfId={profile?.staffId ?? ""} />
    </ConsoleFrame>
  );
}
