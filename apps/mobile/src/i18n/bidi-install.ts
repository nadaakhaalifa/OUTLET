import { isolateInterpolation } from "@outlet/i18n";
import type { i18n } from "i18next";

/**
 * R8: wrap every interpolated value in a bidi isolate for Arabic, centrally. i18next replaces `interpolation.format` with its
 * built-in formatter during init and its typings no longer expose it, so the interpolator's format hook is set here (no
 * catalog in this repo uses `{{x, format}}` specifiers; the format name is ignored on purpose).
 */
export function installBidiIsolates(instance: i18n): void {
  const interpolator = instance.services.interpolator as unknown as { format: typeof isolateInterpolation };
  interpolator.format = isolateInterpolation;
}
