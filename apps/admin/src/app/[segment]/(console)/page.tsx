import { createTranslator } from "@outlet/i18n";
import { ConsoleFrame } from "../../../components/ConsoleFrame";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";
import { currentProfile } from "../../../server/admin-get";
import { visibleSections } from "../../../server/session";

export default async function OverviewPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const profile = await currentProfile();
  const onlyAccess = profile !== null && visibleSections(profile).length <= 1;
  return (
    <ConsoleFrame resolved={resolved} section="overview">
      <h1 className="pageTitle">{t("admin.title")}</h1>
      <p className="lead">{onlyAccess ? t("admin.overview.none") : t("admin.overview.lead")}</p>
    </ConsoleFrame>
  );
}
