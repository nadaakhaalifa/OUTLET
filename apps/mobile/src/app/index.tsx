import { useEffect, useState } from "react";
import { Redirect, type Href } from "expo-router";
import { useServices } from "../state/services";

/** Entry gate: decides between onboarding, the blocked screen and the tabs. */
export default function Index() {
  const services = useServices();
  const [target, setTarget] = useState<Href | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let next: Href = "/onboarding/phone";
      try {
        if (await services.isThisDeviceBlocked()) {
          next = "/onboarding/blocked";
        } else {
          const tokens = await services.tokens.load();
          if (tokens !== null) {
            if (await services.isOnboardingDone()) next = "/(tabs)";
            else {
              const resume = await services.getResume();
              next = resume === "consents" ? "/onboarding/consents" : resume === "language" ? "/onboarding/language" : "/onboarding/dob";
            }
          }
        }
      } catch {
        // Storage unreadable: start from the beginning, which re-asks the age gate.
      }
      if (alive) setTarget(next);
    })();
    return () => {
      alive = false;
    };
  }, [services]);

  if (target === null) return null;
  return <Redirect href={target} />;
}
