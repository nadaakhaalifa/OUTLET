import { createTranslator } from "@outlet/i18n";
import { PasskeyLogin } from "../../../components/PasskeyLogin";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";

export default async function LoginPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  return (
    <main id="content" className="content loginBox" tabIndex={-1}>
      <h1 className="pageTitle">{t("admin.login.title")}</h1>
      <p className="lead">{t("admin.login.lead")}</p>
      <PasskeyLogin locale={resolved.locale} market={resolved.marketId} home={`/${resolved.marketId}-${resolved.locale.startsWith("ar") ? "ar" : "en"}`} />
    </main>
  );
}
