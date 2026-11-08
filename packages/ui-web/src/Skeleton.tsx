import { useEffect, useState } from "react";
import type { Locale } from "@outlet/i18n";
import { useI18n } from "./i18n-context.js";
import { VisuallyHidden } from "./VisuallyHidden.js";
import s from "./Skeleton.module.css";

/** Loading placeholder. Becomes visible only after `delayMs` (default 300) so fast loads never flash. */
export function Skeleton({ delayMs = 300, inlineSize = "100%", blockSize = "1em", locale }: { delayMs?: number; inlineSize?: string; blockSize?: string; locale?: Locale }) {
  const { t } = useI18n(locale);
  const [shown, setShown] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return;
    const id = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(id);
  }, [delayMs]);
  return (
    <div role="status" aria-busy="true" className={s["skeleton"]} data-visible={shown} style={{ inlineSize, blockSize }}>
      {shown ? <VisuallyHidden>{t("state.loading")}</VisuallyHidden> : null}
    </div>
  );
}
