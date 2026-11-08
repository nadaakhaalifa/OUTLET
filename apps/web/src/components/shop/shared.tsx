"use client";
import { useMemo } from "react";
import { createTranslator, formatDate, formatMoney, language, localeSegment, type Locale, type Translator } from "@outlet/i18n";
import type { Money } from "@outlet/money";
import { ApiProblem } from "../../lib/client-api";

export interface Shared {
  readonly t: Translator;
  readonly money: (m: Money) => string;
  readonly date: (iso: string) => string;
  readonly base: string;
}
/** Translator and formatters for one locale. The base path is the market-locale segment, e.g. /eg-ar. */
export function useShared(locale: Locale, marketId = "eg"): Shared {
  return useMemo(
    () => ({ t: createTranslator(locale), money: (m) => formatMoney(m, locale), date: (iso) => formatDate(new Date(iso), locale), base: `/${localeSegment(marketId, locale)}` }),
    [locale, marketId],
  );
}
export const pickName = (locale: Locale, ar: string, en: string | null): string => (language(locale) === "en" && en !== null && en !== "" ? en : ar);

export const isProblem = (e: unknown, status?: number): e is ApiProblem => e instanceof ApiProblem && (status === undefined || e.status === status);

/** Only same-site, in-segment relative paths are honoured after login (no open redirect). */
export function safeNext(next: string | null | undefined, base: string): string {
  if (typeof next === "string" && next.startsWith(`${base}/`) && !next.includes("//") && !next.includes("\\") && !next.includes(":")) return next;
  return base;
}

export function Alert({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="shopAlert">{children}</p>;
}
export function Status({ children }: { children: React.ReactNode }) {
  return <p role="status" className="shopStatus">{children}</p>;
}
