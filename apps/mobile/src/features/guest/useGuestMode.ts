import { useEffect, useState } from "react";
import { useOptionalServices } from "../../state/services";
import { isGuestSession } from "./signals";

/**
 * True while nobody is signed in. Screens use it only to adjust copy and controls (never to prompt sign-up: the only
 * account prompt is the Checkout tap in the Bag). Data adapters decide public vs bearer routes on their own through
 * `AdapterContext.isGuest`, so no screen repeats that choice. Starts false (signed-in behaviour) until the token read resolves.
 */
export function useGuestMode(): boolean {
  const tokens = useOptionalServices()?.tokens ?? null;
  const [guest, setGuest] = useState(false);
  useEffect(() => {
    if (tokens === null) return;
    let alive = true;
    void isGuestSession(tokens).then((g) => { if (alive) setGuest(g); }, () => undefined);
    return () => { alive = false; };
  }, [tokens]);
  return guest;
}
