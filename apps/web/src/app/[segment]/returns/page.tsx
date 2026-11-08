import type { Metadata } from "next";
import { createTranslator } from "@outlet/i18n";
import { ReturnsList } from "../../../components/shop/ReturnsList";
import { pageMetadata } from "../../../lib/metadata";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return { ...pageMetadata(await requireLocale(params), "/returns", "returns.title"), robots: { index: false, follow: false } };
}

export default async function ReturnsPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  return (
    <section aria-labelledby="returns-title">
      <h1 id="returns-title" className="hero">{t("returns.title")}</h1>
      <ReturnsList locale={resolved.locale} />
    </section>
  );
}
