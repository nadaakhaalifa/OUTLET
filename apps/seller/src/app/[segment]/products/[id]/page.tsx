import { notFound } from "next/navigation";
import { createTranslator } from "@outlet/i18n";
import { PageFrame } from "../../../../components/PageFrame";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { ProductWizard } from "../../../../components/wizard/ProductWizard";
import { ProductWire } from "../../../../client/seller-api";
import { requireLocale } from "../../../../lib/segment-page";
import { sellerGet } from "../../../../server/seller-get";

export default async function EditProductPage({ params }: { params: Promise<{ segment: string; id: string }> }) {
  const resolved = await requireLocale(params);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const result = await sellerGet(resolved.marketId.toLowerCase(), `products/${id}`);
  const t = createTranslator(resolved.locale);
  const parsed = result.ok ? ProductWire.safeParse(result.data) : null;
  return (
    <PageFrame resolved={resolved} current="products">
      {parsed?.success === true ? (
        <ProductWizard locale={resolved.locale} marketId={resolved.marketId} product={parsed.data} />
      ) : (
        <ProblemBanner t={t} code={result.ok ? "bad-response" : result.code} status={result.ok ? 502 : result.status} />
      )}
    </PageFrame>
  );
}
