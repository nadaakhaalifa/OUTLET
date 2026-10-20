import { useCallback, useEffect, useMemo, useState } from "react";
import { useServices } from "../../state/services";
import { getFeaturePorts } from "../../state/ports";
import {
  DEFAULT_SORT, DEFAULT_WORLD, decodePreference, encodePreference, failureState,
  type StoreSort, type World, type WorldsPort, type WorldsScreenState,
} from "./model";

const PREF_KEY = "worlds.selection";

/** Shared by Home and Explore: the per-device world/sort choice plus the store list. */
export function useWorld(portOverride?: WorldsPort) {
  const services = useServices();
  const port = useMemo<WorldsPort>(() => portOverride ?? getFeaturePorts().worlds, [portOverride]);
  const [world, setWorldState] = useState<World>(DEFAULT_WORLD);
  const [sort, setSortState] = useState<StoreSort>(DEFAULT_SORT);
  const [state, setState] = useState<WorldsScreenState>({ status: "loading" });

  const load = useCallback(async () => {
    try {
      setState({ status: "ready", stores: await port.listStores() });
    } catch (e) {
      setState(failureState(e));
    }
  }, [port]);

  useEffect(() => {
    void (async () => {
      try {
        const p = decodePreference(await services.storage.getString(PREF_KEY));
        if (p !== null) {
          setWorldState(p.world);
          setSortState(p.sort);
        }
      } catch {
        // Preference unreadable: keep defaults.
      }
    })();
    void load();
  }, [services, load]);

  const choose = useCallback((w: World, s: StoreSort) => {
    setWorldState(w);
    setSortState(s);
    void services.storage.setString(PREF_KEY, encodePreference({ world: w, sort: s })).catch(() => undefined);
  }, [services]);

  return { world, sort, state, reload: load, setWorld: (w: World) => choose(w, sort), setSort: (s: StoreSort) => choose(world, s), choose };
}
