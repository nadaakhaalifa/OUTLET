import type { Metadata } from "next";
import { createTranslator } from "@outlet/i18n";
import { EmptyState } from "../../../components/EmptyState";
import { pageMetadata } from "../../../lib/metadata";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return { ...pageMetadata(await requireLocale(params), "/account", "nav.account"), robots: { index: false, follow: false } };
}

export default async function AccountPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  return (
    <section aria-labelledby="account-title">
      <h1 id="account-title" className="hero">
        {t("nav.account")}
      </h1>
      <EmptyState locale={resolved.locale} />
    </section>
  );
}
