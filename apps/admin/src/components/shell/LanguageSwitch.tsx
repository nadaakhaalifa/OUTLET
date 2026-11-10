"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Locale } from "@outlet/i18n";
import { Icon } from "../kit/Icon";
import { switchLocaleHref } from "./navigation";

/** Toggles AR/EN on the same page, keeping the `[segment]` routing. Named in the language it switches to. */
export function LanguageSwitch({ locale, market, label, targetName }: { locale: Locale; market: string; label: string; targetName: string }) {
  const pathname = usePathname();
  const target: Locale = locale === "ar-EG" ? "en-EG" : "ar-EG";
  return (
    <Link className="btn btnGhost langSwitch" href={switchLocaleHref(pathname, market, target)} lang={target === "ar-EG" ? "ar" : "en"} hrefLang={target === "ar-EG" ? "ar" : "en"} aria-label={`${label}: ${targetName}`}>
      <Icon name="language" />
      <span>{targetName}</span>
    </Link>
  );
}
