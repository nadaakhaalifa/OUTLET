import type { Metadata } from "next";
import { createTranslator } from "@outlet/i18n";
import { AddressBook } from "../../../../components/shop/AddressBook";
import { pageMetadata } from "../../../../lib/metadata";
import { requireLocale, type SegmentParams } from "../../../../lib/segment-page";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return { ...pageMetadata(await requireLocale(params), "/account/addresses", "addresses.title"), robots: { index: false, follow: false } };
}

export default async function AddressesPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  return (
    <section aria-labelledby="addresses-title">
      <h1 id="addresses-title" className="hero">{t("addresses.title")}</h1>
      <AddressBook locale={resolved.locale} />
    </section>
  );
}
