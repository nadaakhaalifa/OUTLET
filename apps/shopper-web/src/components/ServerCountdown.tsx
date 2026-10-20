"use client";
import { useEffect, useState } from "react";
import { createTranslator, type Locale } from "../i18n";
import { remaining } from "../view-models/countdown";

/**
 * Countdown driven by the SERVER clock (GET /api/server-time, fetched once on mount) plus a monotonic timer, so a
 * wrong device clock cannot change it. The server-rendered HTML carries only absolute times (cacheable); if the
 * server time cannot be read this says so instead of guessing.
 */
export function ServerCountdown({ deadlineIso, locale, kind }: { deadlineIso: string; locale: Locale; kind: "startsIn" | "endsIn" }) {
  const [base, setBase] = useState<{ serverMs: number; perf: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const t0 = performance.now();
    fetch("/api/server-time", { cache: "no-store", credentials: "omit" })
      .then((r) => (r.ok ? (r.json() as Promise<{ now?: unknown }>) : Promise.reject(new Error("bad status"))))
      .then((j) => {
        if (!alive) return;
        if (typeof j.now !== "number") throw new Error("bad body");
        // Half the round trip is the best estimate of one-way delay.
        const rtt = performance.now() - t0;
        setBase({ serverMs: j.now + rtt / 2, perf: performance.now() });
      })
      .catch(() => alive && setFailed(true));
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  const t = createTranslator(locale);
  void tick;
  if (failed) return <p role="status">{t("drops.countdown.unavailable")}</p>;
  if (base === null) return <p role="status" aria-busy="true">{" "}</p>;
  const parts = remaining(deadlineIso, base.serverMs, performance.now() - base.perf);
  if (parts === null) return null;
  const bits: string[] = [];
  if (parts.days > 0) bits.push(t("drops.countdown.d", { n: parts.days }));
  if (parts.days > 0 || parts.hours > 0) bits.push(t("drops.countdown.h", { n: parts.hours }));
  bits.push(t("drops.countdown.m", { n: parts.minutes }));
  return <p role="timer" aria-live="off" className="price">{t(`drops.countdown.${kind}`, { time: bits.join(" ") })}</p>;
}
