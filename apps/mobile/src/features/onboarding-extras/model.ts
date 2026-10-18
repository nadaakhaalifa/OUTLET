/** Personalisation steps after consents. Every step is skippable; nothing is pre-selected. */
export const PREF_STEPS = ["vibes", "sizes", "brands", "budget", "notifications"] as const;
export type PrefStep = (typeof PREF_STEPS)[number];

export const VIBE_OPTIONS = ["classic", "street", "minimal", "bold", "modest", "sport"] as const;
export const SIZE_OPTIONS = ["XS", "S", "M", "L", "XL", "XXL"] as const;
export const BRAND_OPTIONS = ["Cairo Denim", "Atlas Sport", "Nile Atelier", "Delta Knit", "Luxor Leather", "Siwa Linen"] as const;

export interface OnboardingPrefs {
  readonly vibes: readonly string[];
  readonly sizes: readonly string[];
  readonly measureLater: boolean;
  readonly brands: readonly string[];
  /** Whole EGP per month, or null when skipped. */
  readonly budgetEgp: number | null;
  readonly notifications: "asked" | "later" | null;
}

export const EMPTY_PREFS: OnboardingPrefs = { vibes: [], sizes: [], measureLater: false, brands: [], budgetEgp: null, notifications: null };

export function toggle(list: readonly string[], value: string): readonly string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function nextPrefStep(step: PrefStep): PrefStep | null {
  return PREF_STEPS[PREF_STEPS.indexOf(step) + 1] ?? null;
}

/** Empty or malformed means "no budget" (skippable); whole EGP, 1 to 9,999,999, Arabic-Indic digits accepted. */
export function parseMonthlyBudget(raw: string): { ok: true; value: number | null } | { ok: false } {
  const s = raw.trim().replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  if (s === "") return { ok: true, value: null };
  if (!/^[0-9]{1,7}$/.test(s) || Number(s) === 0) return { ok: false };
  return { ok: true, value: Number(s) };
}

export function parsePrefs(json: string | null): OnboardingPrefs {
  if (json === null) return EMPTY_PREFS;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null) return EMPTY_PREFS;
    const o = v as Record<string, unknown>;
    const strs = (x: unknown): readonly string[] => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string") : []);
    return {
      vibes: strs(o["vibes"]),
      sizes: strs(o["sizes"]),
      measureLater: o["measureLater"] === true,
      brands: strs(o["brands"]),
      budgetEgp: typeof o["budgetEgp"] === "number" && Number.isInteger(o["budgetEgp"]) && o["budgetEgp"] > 0 ? o["budgetEgp"] : null,
      notifications: o["notifications"] === "asked" || o["notifications"] === "later" ? o["notifications"] : null,
    };
  } catch {
    return EMPTY_PREFS;
  }
}
