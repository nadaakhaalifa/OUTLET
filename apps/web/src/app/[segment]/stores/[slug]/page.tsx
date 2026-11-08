import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createTranslator } from "@outlet/i18n";
import { EmptyState } from "../../../../components/EmptyState";
import { SkeletonGrid } from "../../../../components/SkeletonGrid";
import { storeSlugSchema } from "../../../../lib/params";
import { pageMetadata } from "../../../../lib/metadata";
import { requireLocale } from "../../../../lib/segment-page";
import { loadStore } from "../../../../server/loaders";

type Params = Promise<{ segment: string; slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await requireLocale(params);
  const parsed = storeSlugSchema.safeParse(slug);
  return pageMetadata(resolved, parsed.success ? `/stores/${parsed.data}` : "", "nav.explore");
}

export default async function StorePage({ params }: { params: Params }) {
  const resolved = await requireLocale(params);
  const slug = storeSlugSchema.safeParse((await params).slug);
  if (!slug.success) notFound();
  const store = await loadStore(resolved.marketId, slug.data);
  const t = createTranslator(resolved.locale);
  return (
    <section aria-labelledby="store-title">
      <h1 id="store-title" className="hero">
        {store ? store.name : t("nav.explore")}
      </h1>
      {store ? null : <EmptyState locale={resolved.locale} />}
      <SkeletonGrid locale={resolved.locale} count={18} />
    </section>
  );
}
