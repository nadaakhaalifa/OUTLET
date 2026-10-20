import type { ReactNode } from "react";
import type { OnboardingApi } from "./api/onboarding-client";
import { ErrorNotice } from "./components/ErrorNotice";
import type { Locale, Translator } from "./i18n";
import { getOnboarding, resolveStore, type StoreScope } from "./onboarding-context";

export type SettingsCtx =
  | { readonly ok: true; readonly api: OnboardingApi; readonly scope: StoreScope; readonly t: Translator; readonly locale: Locale }
  | { readonly ok: false; readonly node: ReactNode };

/** Shared first step of every settings page: API configured, signed in, and a store membership. */
export async function settingsCtx(): Promise<SettingsCtx> {
  const { api, t, locale } = await getOnboarding();
  if (api === null) return { ok: false, node: <ErrorNotice kind="not_configured" locale={locale} /> };
  const s = await resolveStore(api);
  if (s.unauthorized) return { ok: false, node: <ErrorNotice error={{ kind: "unauthorized" }} locale={locale} /> };
  if (s.offline) return { ok: false, node: <ErrorNotice error={{ kind: "offline" }} locale={locale} /> };
  if (s.scope === null) return { ok: false, node: <ErrorNotice kind="no_store" locale={locale} /> };
  return { ok: true, api, scope: s.scope, t, locale };
}

export const canWriteSettings = (role: string): boolean => role === "owner" || role === "manager";
