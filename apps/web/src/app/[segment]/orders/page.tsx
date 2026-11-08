import type { Metadata } from "next";
import { createTranslator } from "@outlet/i18n";
import { OrdersList } from "../../../components/shop/OrdersList";
import { pageMetadata } from "../../../lib/metadata";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return { ...pageMetadata(await requireLocale(params), "/orders", "orders.title"), robots: { index: false, follow: false } };
}

export default async function OrdersPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  return (
    <section aria-labelledby="orders-title">
      <h1 id="orders-title" className="hero">{t("orders.title")}</h1>
      <OrdersList locale={resolved.locale} />
    </section>
  );
}
