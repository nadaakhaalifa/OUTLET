import { PageFrame } from "../../../../components/PageFrame";
import { ProductWizard } from "../../../../components/wizard/ProductWizard";
import { requireLocale, type SegmentParams } from "../../../../lib/segment-page";

export default async function NewProductPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  return (
    <PageFrame resolved={resolved} current="products">
      <ProductWizard locale={resolved.locale} marketId={resolved.marketId} />
    </PageFrame>
  );
}
