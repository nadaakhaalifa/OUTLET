import { useEffect, useState } from "react";
import type { Locale } from "@outlet/i18n";
import { useI18n } from "./i18n-context.js";
import { VisuallyHidden } from "./VisuallyHidden.js";
import s from "./Skeleton.module.css";

/** Fixed size classes (no inline style: strict CSP forbids style attributes). */
export type SkeletonSize = "text" | "price" | "tile" | "image" | "line70" | "line40";

/** Loading placeholder. Becomes visible only after `delayMs` (default 300) so fast loads never flash. */
export function Skeleton({ delayMs = 300, size = "text", locale }: { delayMs?: number; size?: SkeletonSize; locale?: Locale }) {
  const { t } = useI18n(locale);
  const [shown, setShown] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return;
    const id = setTimeout(() => {
      setShown(true);
    }, delayMs);
    return () => {
      clearTimeout(id);
    };
  }, [delayMs]);
  return (
    <div role="status" aria-busy="true" className={`${s.skeleton} ${s[size]}`} data-visible={shown} data-size={size}>
      {shown ? <VisuallyHidden>{t("state.loading")}</VisuallyHidden> : null}
    </div>
  );
}
