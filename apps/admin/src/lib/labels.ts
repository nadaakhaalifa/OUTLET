import type { MessageKey } from "@outlet/i18n";
import type { Translator } from "@outlet/i18n";

/** Looks up `${prefix}.${value}` and falls back to the raw API value for codes the catalog does not know yet. */
export function label(t: Translator, prefix: string, value: string): string {
  const key = `${prefix}.${value}`;
  try {
    return t(key as MessageKey);
  } catch {
    return value;
  }
}
