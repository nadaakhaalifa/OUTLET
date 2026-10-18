import { notFound } from "next/navigation";
import { readSiteUrl } from "../api/config";
import { isLocale, type Locale } from "../i18n";

export const SITE = readSiteUrl(process.env);

/** Validates the [locale] segment; unknown prefixes are 404 (the proxy redirects locale-less paths first). */
export function localeOf(raw: string): Locale {
  if (!isLocale(raw)) notFound();
  return raw;
}
