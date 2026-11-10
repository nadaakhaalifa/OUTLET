import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createTranslator } from "@outlet/i18n";
import { ReturnDetail } from "../../../../components/shop/ReturnDetail";
import { pageMetadata } from "../../../../lib/metadata";
import { requireLocale } from "../../../../lib/segment-page";

type Params = Promise<{ segment: string; id: string }>;
const ID = /^[A-Za-z0-9-]{8,64}$/;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { ...pageMetadata(await requireLocale(params), "", "returns.detail.title"), robots: { index: false, follow: false } };
}

export default async function ReturnPage({ params }: { params: Params }) {
  const resolved = await requireLocale(params);
  const { id } = await params;
  if (!ID.test(id)) notFound();
  const t = createTranslator(resolved.locale);
  return (
    <section aria-labelledby="return-title">
      <h1 id="return-title" className="hero">{t("returns.detail.title")}</h1>
      <ReturnDetail locale={resolved.locale} returnId={id} />
    </section>
  );
}
