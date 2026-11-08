import ar from "./catalogs/ar-EG.json";
import en from "./catalogs/en-EG.json";
import type { Locale } from "./locale.js";

/** Keys come from the Arabic catalog (the required one); en must carry the same keys (check-catalogs). */
export type MessageKey = keyof typeof ar;

export const CATALOGS: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { "ar-EG": ar, "en-EG": en };
