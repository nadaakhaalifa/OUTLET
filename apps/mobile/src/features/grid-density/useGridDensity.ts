import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { gridColumnsForWindow, useLayout } from "@outlet/ui-native";
import { useServices } from "../../state/services";
import { gridDensityStore } from "./gridDensityStore";
import {
  DENSITY_STORAGE_KEY, allowedDensities, clamp, cycleDensity, maxDensityForFontScale, parseDensity, serializeDensity,
  stepDenser as stepDenserModel, stepSparser as stepSparserModel, type Density,
} from "./model";

export interface GridDensityApi {
  /** Effective density: the saved choice, capped by the current font scale. */
  readonly density: Density;
  readonly setDensity: (next: Density) => void;
  readonly stepDenser: () => void;
  readonly stepSparser: () => void;
  /** One tap of the toggle: 2 -> 3 -> 4 -> 1 -> 2 within `allowed`. */
  readonly cycle: () => void;
  readonly allowed: readonly Density[];
  /** Columns for a full-width grid in this window (adaptive on iPad, the density itself on iPhone). */
  readonly columns: number;
}

/** Shared per-device grid density. Storage failures keep the in-memory value and the default of 2. */
export function useGridDensity(): GridDensityApi {
  const services = useServices();
  const { fontScale, windowWidth, sizeClass } = useLayout();
  const zoomed = sizeClass !== "compact";
  const saved = useSyncExternalStore(gridDensityStore.subscribe, gridDensityStore.get, gridDensityStore.get);
  const max = maxDensityForFontScale(fontScale, zoomed);

  useEffect(() => {
    if (gridDensityStore.isHydrated()) return;
    void (async () => {
      try {
        gridDensityStore.hydrate(parseDensity(await services.storage.getString(DENSITY_STORAGE_KEY)));
      } catch {
        gridDensityStore.markHydrated(); // unreadable: keep default
      }
    })();
  }, [services]);

  const setDensity = useCallback((next: Density) => {
    const v = clamp(next, maxDensityForFontScale(fontScale, zoomed));
    gridDensityStore.markHydrated();
    gridDensityStore.set(v);
    void services.storage.setString(DENSITY_STORAGE_KEY, serializeDensity(v)).catch(() => undefined);
  }, [services, fontScale, zoomed]);

  const density = clamp(saved, max);
  const allowed = useMemo(() => allowedDensities(fontScale, zoomed), [fontScale, zoomed]);
  return {
    density,
    setDensity,
    stepDenser: () => setDensity(stepDenserModel(density, max)),
    stepSparser: () => setDensity(stepSparserModel(density)),
    cycle: () => setDensity(cycleDensity(density, max)),
    allowed,
    columns: zoomed ? gridColumnsForWindow(windowWidth, density, fontScale) : density,
  };
}
