"use client";

import { useEffect, useState } from "react";
import { createTranslator, type Locale } from "@outlet/i18n";

const WARN_MS = 5 * 60_000;

/** Quiet reminder when the staff session is about to end (the server still decides; this is a hint only). */
export function IdleHint({ expiresAt, locale }: { expiresAt: string; locale: Locale }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const end = Date.parse(expiresAt);
    if (Number.isNaN(end)) return;
    const tick = () => { setLeft(end - Date.now()); };
    tick();
    const id = setInterval(tick, 15_000);
    return () => { clearInterval(id); };
  }, [expiresAt]);
  if (left === null || left > WARN_MS) return null;
  const t = createTranslator(locale);
  return (
    <p className="idleHint" role="status" data-testid="idle-hint">
      {left <= 0 ? t("admin.topbar.idleExpired") : t("admin.topbar.idle", { minutes: Math.max(1, Math.ceil(left / 60_000)) })}
    </p>
  );
}
