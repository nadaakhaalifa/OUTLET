import { useEffect, useState } from "react";
import { Redirect, type Href } from "expo-router";
import { landingForSignedIn } from "../features/brand-mode/state";
import { useServices } from "../state/services";
import { resolveEntry } from "../features/role-choice/model";

/**
 * Entry gate (ADR-0055): first launch region screen then the entrance page, once; every later launch Home as a guest or
 * member. Never routes into sign-up.
 */
export default function Index() {
  const services = useServices();
  const [target, setTarget] = useState<Href | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let next: Href = "/(tabs)";
      try {
        const blocked = await services.isThisDeviceBlocked();
        const tokens = await services.tokens.load();
        next = resolveEntry({
          blocked,
          role: await services.role.load(),
          regionChosen: (await services.region.load()) !== null,
        }) as Href;
        // Approved brands (real backend only) land in brand mode.
        if (next === "/(tabs)" && tokens !== null) {
          const landing = await landingForSignedIn();
          if (landing !== null) next = landing as Href;
        }
      } catch {
        // Storage unreadable: open Home as a guest rather than repeat first-launch screens.
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
