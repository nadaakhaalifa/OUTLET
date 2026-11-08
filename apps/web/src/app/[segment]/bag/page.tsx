import type { Metadata } from "next";
import { createTranslator } from "@outlet/i18n";
import { EmptyState } from "../../../components/EmptyState";
import { pageMetadata } from "../../../lib/metadata";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return { ...pageMetadata(await requireLocale(params), "/bag", "bag.title"), robots: { index: false, follow: false } };
}

export default async function BagPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  return (
    <section aria-labelledby="bag-title">
      <h1 id="bag-title" className="hero">
        {t("bag.title")}
      </h1>
      <EmptyState locale={resolved.locale} titleKey="bag.empty" hintKey="bag.emptyHint" />
    </section>
  );
}
