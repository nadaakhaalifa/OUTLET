"use client";
import { useEffect, useState } from "react";
import { createTranslator, type Locale } from "../i18n";
import { slaCountdown } from "../view-models/sla";

/**
 * Countdown driven by the SERVER clock captured at fetch time plus a monotonic timer (performance.now),
 * so a wrong device clock cannot change it. Without a server time it says so instead of guessing.
 */
export function ServerCountdown({
  deadlineIso, serverNowMs, locale, label,
}: { deadlineIso: string; serverNowMs: number | null; locale: Locale; label: "countdown.remaining" | "countdown.starts" }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const id = window.setInterval(() => setElapsed(performance.now() - start), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const t = createTranslator(locale);
  const c = slaCountdown({ deadlineIso, serverNowMs, elapsedSinceFetchMs: elapsed });
  if (c.level === "none") return <span className="pill">{t("countdown.none")}</span>;
  if (c.level === "overdue") return <span className="pill warn" role="status">{t("countdown.over")}</span>;
  return <span className={c.level === "warning" ? "pill warn" : "pill"}>{t(label, { hours: c.hours, minutes: c.minutes })}</span>;
}
