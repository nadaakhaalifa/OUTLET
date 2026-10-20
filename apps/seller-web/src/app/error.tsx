"use client";
import { createTranslator, defaultLocale } from "../i18n";

/** Route-level error boundary: shows a generic message and a retry; never the thrown message (no leakage). */
export default function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = createTranslator(defaultLocale);
  return (
    <div role="alert" className="banner error">
      <p>{t("state.error")}</p>
      <button type="button" className="btn" onClick={reset}>{t("common.retry")}</button>
    </div>
  );
}
