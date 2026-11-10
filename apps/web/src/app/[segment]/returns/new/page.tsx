import type { Metadata } from "next";
import { createTranslator } from "@outlet/i18n";
import { ReturnForm } from "../../../../components/shop/ReturnForm";
import { pageMetadata } from "../../../../lib/metadata";
import { requireLocale, type SegmentParams } from "../../../../lib/segment-page";

const ID = /^[A-Za-z0-9-]{8,64}$/;
type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined): string | null => (typeof v === "string" && ID.test(v) ? v : null);

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return { ...pageMetadata(await requireLocale(params), "/returns/new", "returns.new.title"), robots: { index: false, follow: false } };
}

export default async function NewReturnPage({ params, searchParams }: { params: SegmentParams; searchParams: Search }) {
  const resolved = await requireLocale(params);
  const q = await searchParams;
  const t = createTranslator(resolved.locale);
  return (
    <section aria-labelledby="return-new-title">
      <h1 id="return-new-title" className="hero">{t("returns.new.title")}</h1>
      <ReturnForm locale={resolved.locale} lineId={one(q.line)} orderId={one(q.order)} />
    </section>
  );
}
