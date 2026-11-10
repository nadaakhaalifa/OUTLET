import Link from "next/link";
import { createTranslator, localeSegment } from "@outlet/i18n";
import { PageFrame } from "../../components/PageFrame";
import { requireLocale, type SegmentParams } from "../../lib/segment-page";

export default async function OverviewPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  return (
    <PageFrame resolved={resolved} current="overview">
      <h1 className="pageTitle">{t("seller.nav.overview")}</h1>
      <p className="lead">{t("seller.overview.lead")}</p>
      <p>
        <Link className="btnLink" href={`${base}/onboarding`}>
          {t("seller.overview.onboarding")}
        </Link>
      </p>
      <p>
        <Link className="btnLink" href={`${base}/products/new`}>
          {t("seller.products.add")}
        </Link>
      </p>
    </PageFrame>
  );
}
