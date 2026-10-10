import { z } from "zod";

/** Wire locales (OpenAPI `Locale`). Arabic first. */
export const LocaleSchema = z.enum(["ar-EG", "en"]);
export type Locale = z.infer<typeof LocaleSchema>;
export const DEFAULT_LOCALE: Locale = "ar-EG";

/** Language code used by domain packages that only distinguish `ar` and `en`. */
export function toLanguage(locale: Locale): "ar" | "en" {
  return locale === "ar-EG" ? "ar" : "en";
}
