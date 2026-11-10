import { createTranslator } from "@outlet/i18n";
import { PageFrame } from "../../../components/PageFrame";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";

export default async function HelpPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  return (
    <PageFrame resolved={resolved} current="help">
      <h1 className="pageTitle">{t("seller.help.title")}</h1>
      <p className="lead">{t("seller.help.body")}</p>
    </PageFrame>
  );
}
