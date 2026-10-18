import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { getApiRuntime } from "../../services/runtime";
import { useServices } from "../../state/services";
import { isGuestSession } from "../guest";
import { guestRule, type GuestFeature, type GuestRule } from "../guest/capabilities";
import { resolveGuestMode, type GuestMode } from "./guest-mode";

/**
 * Thin tri-state wrapper over the shared session helper (`isGuestSession`, features/guest): the "is this a guest" decision
 * lives there only. The boolean `useGuestMode` starts false, which would flash member-only content on a guarded route,
 * so guards need the extra "unknown" state until the first token read resolves. Re-read on focus (a sign-in flips it).
 */
export function useGuestGateMode(): GuestMode {
  const services = useServices();
  const [mode, setMode] = useState<GuestMode>("unknown");
  useFocusEffect(useCallback(() => {
    let alive = true;
    const configured = getApiRuntime() !== null;
    if (!configured) { setMode(resolveGuestMode({ backendConfigured: false, hasTokens: null })); return undefined; }
    isGuestSession(services.tokens).then(
      (g: boolean) => { if (alive) setMode(resolveGuestMode({ backendConfigured: true, hasTokens: !g })); },
      () => { if (alive) setMode("guest"); },
    );
    return () => { alive = false; };
  }, [services]));
  return mode;
}

export interface GuestView { readonly mode: GuestMode; readonly isGuest: boolean; readonly rule: (f: GuestFeature) => GuestRule }

/** `useGuest()`: one helper so every guard reads the same table. */
export function useGuest(): GuestView {
  const mode = useGuestGateMode();
  return { mode, isGuest: mode === "guest", rule: guestRule };
}
