/**
 * Single source of truth for layout direction (pure, no React Native imports).
 * The active language decides it: ar -> RTL, en -> LTR. The native layout manager must agree with that
 * before the first render; when it does not, we flip it and reload once, guarded against reload loops.
 */
export type DirectionLanguage = "ar" | "en";

export function isRtlLanguage(lang: DirectionLanguage): boolean {
  return lang === "ar";
}

/** True when the native layout direction disagrees with the language (a reload is needed to fix it). */
export function directionMismatch(lang: DirectionLanguage, nativeIsRtl: boolean): boolean {
  return isRtlLanguage(lang) !== nativeIsRtl;
}

export type ReloadAction = "none" | "reload" | "give_up";

export interface ReloadDecision {
  readonly action: ReloadAction;
  /** The value to persist as the one-shot guard: the language a reload was issued for, or null to clear it. */
  readonly nextGuard: DirectionLanguage | null;
}

/** Parses the persisted one-shot guard; anything unexpected reads as "no reload was attempted". */
export function parseReloadGuard(raw: string | null): DirectionLanguage | null {
  return raw === "ar" || raw === "en" ? raw : null;
}

/**
 * Decides what to do at launch or after a language change.
 * - no mismatch: nothing to do, clear the guard;
 * - mismatch and a reload for this very language was already issued: the reload did not take (unsupported
 *   runtime), give up and clear the guard so the next cold launch gets one more try. Never loops;
 * - otherwise reload once and record the guard.
 */
export function decideReload(lang: DirectionLanguage, nativeIsRtl: boolean, guard: DirectionLanguage | null): ReloadDecision {
  if (!directionMismatch(lang, nativeIsRtl)) return { action: "none", nextGuard: null };
  if (guard === lang) return { action: "give_up", nextGuard: null };
  return { action: "reload", nextGuard: lang };
}
