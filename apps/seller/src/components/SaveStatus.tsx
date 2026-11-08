"use client";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createTranslator, type Locale } from "@outlet/i18n";

export type SaveState = "idle" | "saving" | "saved" | "error";
interface Ctx {
  readonly state: SaveState;
  readonly set: (s: SaveState) => void;
}
const SaveCtx = createContext<Ctx>({ state: "idle", set: () => undefined });

export function SaveStatusProvider({ children }: { children: ReactNode }) {
  const [state, set] = useState<SaveState>("idle");
  const value = useMemo(() => ({ state, set }), [state]);
  return <SaveCtx.Provider value={value}>{children}</SaveCtx.Provider>;
}
export const useSaveStatus = (): Ctx => useContext(SaveCtx);

/** Top-bar "Saved as draft" indicator (a polite live region so screen readers hear save results). */
export function SaveIndicator({ locale }: { locale: Locale }) {
  const { state } = useSaveStatus();
  const t = createTranslator(locale);
  const text = state === "saved" ? t("seller.topbar.saved") : state === "saving" ? t("seller.topbar.saving") : state === "error" ? t("seller.topbar.saveFailed") : "";
  return (
    <p className="saveIndicator" role="status" aria-live="polite" data-state={state}>
      {text}
    </p>
  );
}
