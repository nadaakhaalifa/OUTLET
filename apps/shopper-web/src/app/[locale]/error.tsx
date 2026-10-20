"use client";
import { usePathname } from "next/navigation";
import { createTranslator } from "../../i18n";

export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  const locale = (usePathname() ?? "").startsWith("/en") ? "en" : "ar";
  const t = createTranslator(locale);
  return (
    <>
      <h1>{t("state.error")}</h1>
      <p className="note warn" role="alert">{t("state.unavailable")}</p>
      <button className="btn" type="button" onClick={reset}>{t("state.retry")}</button>
    </>
  );
}
