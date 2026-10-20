// Publish validator (ADR-0057 decisions 3 and 4): typed blocking and warning results.
// Nothing is auto-altered: contrast failures carry a suggestion the seller must accept explicitly.

import { checkTheme, type ContrastFailure } from "./contrast";
import { resolveDarkPalette } from "./dark";
import { findCopyViolations, type CopyViolationKind } from "./copy-guard";
import { findPairing, pairingSupportsWeight, PLATFORM_DEFAULT_PAIRING_ID } from "./fonts";
import { suggestPassingColour } from "./suggest";
import type { LocalisedText, PaletteRole, ThemeDocument } from "./types";
import { MAX_SECTIONS, MAX_TAGLINE_LENGTH } from "./types";
import { CONTRAST_PAIRS } from "./contrast";

export type ThemeIssue =
  | {
      readonly severity: "blocking";
      readonly code: "contrast_failed";
      readonly scheme: "light" | "dark";
      readonly fg: PaletteRole;
      readonly bg: PaletteRole;
      readonly ratio: number;
      readonly min: number;
      /** Suggested replacement for `fg`, valid against this pair's background. Seller must accept. */
      readonly suggestion: string;
    }
  | { readonly severity: "blocking"; readonly code: "unknown_pairing" }
  | { readonly severity: "blocking"; readonly code: "weight_unavailable" }
  | { readonly severity: "blocking"; readonly code: "tagline_arabic_required" }
  | { readonly severity: "blocking"; readonly code: "tagline_too_long" }
  | { readonly severity: "blocking"; readonly code: "too_many_sections" }
  | {
      readonly severity: "blocking";
      readonly code: "forbidden_claim";
      readonly field: string;
      readonly kind: CopyViolationKind;
    }
  | { readonly severity: "warning"; readonly code: "dark_derived" }
  | { readonly severity: "warning"; readonly code: "cover_without_scrim" }
  | { readonly severity: "warning"; readonly code: "tagline_english_missing" };

export interface ThemeValidationResult {
  readonly ok: boolean;
  readonly blocking: readonly Extract<ThemeIssue, { severity: "blocking" }>[];
  readonly warnings: readonly Extract<ThemeIssue, { severity: "warning" }>[];
}

function contrastIssue(theme: ThemeDocument, f: ContrastFailure): ThemeIssue {
  const palette = f.scheme === "light" ? theme.light : resolveDarkPalette(theme.light, theme.dark);
  const bg = palette[f.pair.bg];
  return {
    severity: "blocking",
    code: "contrast_failed",
    scheme: f.scheme,
    fg: f.pair.fg,
    bg: f.pair.bg,
    ratio: f.ratio,
    min: f.pair.min,
    suggestion: suggestPassingColour(palette[f.pair.fg], [bg], f.pair.min),
  };
}

function textFields(theme: ThemeDocument): [string, LocalisedText][] {
  const out: [string, LocalisedText][] = [];
  if (theme.tagline) out.push(["tagline", theme.tagline]);
  theme.sections.forEach((s, i) => {
    if (s.kind === "editorial_text") out.push([`sections/${i}`, s.text]);
  });
  return out;
}

export function validateThemeForPublish(theme: ThemeDocument): ThemeValidationResult {
  const blocking: Extract<ThemeIssue, { severity: "blocking" }>[] = [];
  const warnings: Extract<ThemeIssue, { severity: "warning" }>[] = [];
  const push = (i: ThemeIssue): void => {
    if (i.severity === "blocking") blocking.push(i);
    else warnings.push(i);
  };

  const dark = resolveDarkPalette(theme.light, theme.dark);
  for (const f of checkTheme(theme, dark)) push(contrastIssue(theme, f));
  if (theme.dark === null) push({ severity: "warning", code: "dark_derived" });

  if (theme.pairingId !== PLATFORM_DEFAULT_PAIRING_ID && !findPairing(theme.pairingId)) {
    push({ severity: "blocking", code: "unknown_pairing" });
  } else if (!pairingSupportsWeight(theme.pairingId, theme.displayWeight)) {
    push({ severity: "blocking", code: "weight_unavailable" });
  }

  if (theme.sections.length > MAX_SECTIONS) push({ severity: "blocking", code: "too_many_sections" });

  const tag = theme.tagline;
  if (tag) {
    if (tag.ar.trim() === "") push({ severity: "blocking", code: "tagline_arabic_required" });
    if (tag.en.trim() === "") push({ severity: "warning", code: "tagline_english_missing" });
    if (tag.ar.length > MAX_TAGLINE_LENGTH || tag.en.length > MAX_TAGLINE_LENGTH) {
      push({ severity: "blocking", code: "tagline_too_long" });
    }
  }
  for (const [field, text] of textFields(theme)) {
    for (const lang of ["ar", "en"] as const) {
      for (const v of findCopyViolations(text[lang])) {
        push({ severity: "blocking", code: "forbidden_claim", field: `${field}/${lang}`, kind: v.kind });
      }
    }
  }

  if (theme.coverAssetId !== null && theme.light.heroScrim.alpha === 0) {
    push({ severity: "warning", code: "cover_without_scrim" });
  }

  return { ok: blocking.length === 0, blocking, warnings };
}

/** Pair list re-exported so editors can render a contrast meter without importing two modules. */
export { CONTRAST_PAIRS };
