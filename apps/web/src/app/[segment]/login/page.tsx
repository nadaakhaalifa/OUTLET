import type { Metadata } from "next";
import { createTranslator } from "@outlet/i18n";
import { LoginForm } from "../../../components/shop/LoginForm";
import { pageMetadata } from "../../../lib/metadata";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return { ...pageMetadata(await requireLocale(params), "/login", "auth.title"), robots: { index: false, follow: false } };
}

export default async function LoginPage({ params, searchParams }: { params: SegmentParams; searchParams: Promise<{ next?: string | string[] }> }) {
  const resolved = await requireLocale(params);
  const next = (await searchParams).next;
  const t = createTranslator(resolved.locale);
  return (
    <section aria-labelledby="login-title">
      <h1 id="login-title" className="hero">{t("auth.title")}</h1>
      <LoginForm locale={resolved.locale} next={typeof next === "string" ? next : null} />
    </section>
  );
}
