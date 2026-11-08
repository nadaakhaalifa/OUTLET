import type { Metadata } from "next";
import { createTranslator } from "@outlet/i18n";
import { CheckoutView } from "../../../components/shop/CheckoutView";
import { pageMetadata } from "../../../lib/metadata";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return { ...pageMetadata(await requireLocale(params), "/checkout", "checkout.title"), robots: { index: false, follow: false } };
}

export default async function CheckoutPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  return (
    <section aria-labelledby="checkout-title">
      <h1 id="checkout-title" className="hero">{t("checkout.title")}</h1>
      <CheckoutView locale={resolved.locale} />
    </section>
  );
}
