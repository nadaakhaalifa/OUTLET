"use client";
import { useEffect, useState } from "react";
import { createTranslator, type Locale } from "@outlet/i18n";
import { slaRemaining } from "../../lib/sla";

/**
 * Time left to accept or dispatch. The first render uses the SERVER's clock (`serverTime`), so server and browser agree and a wrong
 * device clock cannot hide a deadline; afterwards it ticks with the offset between the server and the browser clock.
 */
export function SlaCountdown({ locale, kind, deadline, serverTime }: { locale: Locale; kind: "accept" | "dispatch"; deadline: string; serverTime: string }) {
  const t = createTranslator(locale);
  const [now, setNow] = useState(() => Date.parse(serverTime));
  useEffect(() => {
    const offset = Date.parse(serverTime) - Date.now();
    const tick = (): void => { setNow(Date.now() + offset); };
    tick();
    const id = setInterval(tick, 30_000);
    return () => { clearInterval(id); };
  }, [serverTime]);
  const r = slaRemaining(new Date(deadline), new Date(now));
  const time = t("seller.orders.sla.time", { hours: r.hours, minutes: r.minutes });
  const key = kind === "accept" ? (r.late ? "seller.orders.sla.acceptLate" : "seller.orders.sla.acceptIn") : r.late ? "seller.orders.sla.dispatchLate" : "seller.orders.sla.dispatchIn";
  return (
    <time className="sla" dateTime={deadline} data-late={r.late}>
      {t(key, { time })}
    </time>
  );
}
