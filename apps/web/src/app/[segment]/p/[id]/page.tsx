import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createTranslator } from "@outlet/i18n";
import { EmptyState } from "../../../../components/EmptyState";
import { PriceBlock } from "../../../../components/ui";
import { productIdSchema } from "../../../../lib/params";
import { pageMetadata } from "../../../../lib/metadata";
import { requireLocale } from "../../../../lib/segment-page";
import { loadProduct } from "../../../../server/loaders";

type Params = Promise<{ segment: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const resolved = await requireLocale(params);
  const parsed = productIdSchema.safeParse(id);
  return pageMetadata(resolved, parsed.success ? `/p/${parsed.data}` : "", "product.quickView");
}

export default async function ProductPage({ params }: { params: Params }) {
  const resolved = await requireLocale(params);
  const id = productIdSchema.safeParse((await params).id);
  if (!id.success) notFound();
  // Price and stock are read live on every request (never from a cached fetch).
  const product = await loadProduct(resolved.marketId, id.data);
  const t = createTranslator(resolved.locale);
  if (product === null) {
    return (
      <section aria-labelledby="product-title">
        <h1 id="product-title" className="hero">
          {t("product.unavailable")}
        </h1>
        <EmptyState locale={resolved.locale} />
      </section>
    );
  }
  return (
    <section aria-labelledby="product-title">
      <h1 id="product-title" className="hero">
        {product.name}
      </h1>
      <PriceBlock {...product.pricing} locale={resolved.locale} />
    </section>
  );
}
