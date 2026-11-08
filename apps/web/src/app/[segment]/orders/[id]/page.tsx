import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createTranslator } from "@outlet/i18n";
import { OrderStatus } from "../../../../components/shop/OrderStatus";
import { pageMetadata } from "../../../../lib/metadata";
import { requireLocale } from "../../../../lib/segment-page";

type Params = Promise<{ segment: string; id: string }>;
const ID = /^[A-Za-z0-9-]{8,64}$/;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { ...pageMetadata(await requireLocale(params), "", "checkout.order.title"), robots: { index: false, follow: false } };
}

export default async function OrderPage({ params }: { params: Params }) {
  const resolved = await requireLocale(params);
  const { id } = await params;
  if (!ID.test(id)) notFound();
  const t = createTranslator(resolved.locale);
  return (
    <section aria-labelledby="order-title">
      <h1 id="order-title" className="hero">{t("checkout.order.title")}</h1>
      <OrderStatus locale={resolved.locale} orderId={id} />
    </section>
  );
}
