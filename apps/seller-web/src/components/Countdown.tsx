"use client";
import { useEffect, useState } from "react";
import { createTranslator, type Locale } from "../i18n";
import { slaCountdown } from "../view-models/sla";

/**
 * Accept-by countdown driven by the SERVER clock captured at fetch time plus a monotonic elapsed timer
 * (performance.now), so a wrong device clock cannot change it. Without a server time it renders nothing misleading.
 */
export function Countdown({ deadlineIso, serverNowMs, locale }: { deadlineIso: string; serverNowMs: number | null; locale: Locale }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const id = window.setInterval(() => setElapsed(performance.now() - start), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const t = createTranslator(locale);
  const c = slaCountdown({ deadlineIso, serverNowMs, elapsedSinceFetchMs: elapsed });
  if (c.level === "none") return <span className="pill">{t("orders.sla.none")}</span>;
  if (c.level === "overdue") return <span className="pill warn" role="status">{t("orders.sla.overdue")}</span>;
  const key = c.level === "warning" ? "orders.sla.warning" : "orders.sla.remaining";
  return (
    <span className={c.level === "warning" ? "pill warn" : "pill"}>
      {t(key, { hours: c.hours, minutes: c.minutes })}
    </span>
  );
}
