import { DEFAULT_DENSITY, type Density } from "./model";

/** Tiny shared store so every screen sees the same density. Persistence lives in useGridDensity. */
let current: Density = DEFAULT_DENSITY;
let hydrated = false;
const listeners = new Set<() => void>();

export const gridDensityStore = {
  get: (): Density => current,
  isHydrated: (): boolean => hydrated,
  set(next: Density): void {
    if (next === current) return;
    current = next;
    listeners.forEach((l) => l());
  },
  /** Applies the persisted value once, unless the user already changed it this session. */
  hydrate(value: Density): void {
    if (hydrated) return;
    hydrated = true;
    gridDensityStore.set(value);
  },
  markHydrated(): void { hydrated = true; },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};
