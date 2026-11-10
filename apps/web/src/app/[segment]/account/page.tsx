import type { Metadata } from "next";
import { createTranslator } from "@outlet/i18n";
import { AccountPanel } from "../../../components/shop/AccountPanel";
import { pageMetadata } from "../../../lib/metadata";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return { ...pageMetadata(await requireLocale(params), "/account", "account.title"), robots: { index: false, follow: false } };
}

export default async function AccountPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  return (
    <section aria-labelledby="account-title">
      <h1 id="account-title" className="hero">{t("account.title")}</h1>
      <AccountPanel locale={resolved.locale} />
    </section>
  );
}
