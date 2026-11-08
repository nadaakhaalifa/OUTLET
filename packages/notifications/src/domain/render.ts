import { IntlMessageFormat } from "intl-messageformat";
import { intlTag } from "@outlet/i18n";
import type { Locale } from "@outlet/i18n";
import type { Category, Channel } from "./types.js";

export interface Template {
  readonly code: string;
  readonly channel: Channel;
  readonly locale: Locale;
  readonly version: number;
  readonly category: Category;
  readonly title: string | null;
  readonly body: string;
  readonly providerTemplateName: string | null;
  readonly approvalStatus: "approved" | "pending" | "rejected";
}

export type TemplateVars = Readonly<Record<string, string | number>>;

export interface Rendered {
  readonly locale: Locale;
  readonly title: string | null;
  readonly body: string;
  readonly providerTemplateName: string | null;
  readonly template: Template;
}

export type RenderResult =
  | { readonly ok: true; readonly value: Rendered }
  | { readonly ok: false; readonly reason: "no_template" | "template_not_approved" };

/** Arabic first, then the user's own locale, then English. Duplicates removed, order kept. */
export const localeChain = (userLocale: Locale): readonly Locale[] => [...new Set<Locale>([userLocale, "ar-EG", "en-EG"])];

const format = (message: string, locale: Locale, vars: TemplateVars): string | null => {
  try {
    const out = new IntlMessageFormat(message, intlTag(locale, undefined)).format(vars);
    const s = Array.isArray(out) ? out.join("") : String(out);
    return s.length > 0 ? s : null;
  } catch {
    // A missing variable or malformed ICU message must never leak the raw pattern; try the next locale instead.
    return null;
  }
};

/**
 * Picks the best template for (code, channel): the user's locale first when it is Arabic or the only one available, falling back
 * AR then EN. The newest approved version per locale wins. Never returns a raw key or an unformatted pattern.
 * A WhatsApp template that is not approved is reported as `template_not_approved` (dispatcher falls back to SMS).
 */
export const renderTemplate = (
  templates: readonly Template[],
  code: string,
  channel: Channel,
  userLocale: Locale,
  vars: TemplateVars,
): RenderResult => {
  const mine = templates.filter((t) => t.code === code && t.channel === channel);
  let sawUnapproved = false;
  for (const locale of localeChain(userLocale)) {
    const candidates = mine.filter((t) => t.locale === locale).sort((a, b) => b.version - a.version);
    for (const t of candidates) {
      if (t.approvalStatus !== "approved") {
        sawUnapproved = true;
        continue;
      }
      const body = format(t.body, locale, vars);
      if (body === null) continue;
      const title = t.title === null ? null : format(t.title, locale, vars);
      return { ok: true, value: { locale, title, body, providerTemplateName: t.providerTemplateName, template: t } };
    }
  }
  return { ok: false, reason: sawUnapproved ? "template_not_approved" : "no_template" };
};
