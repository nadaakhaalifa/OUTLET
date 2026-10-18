import { apiBaseUrlFromEnv, createAdapterContext, getApiRuntime } from "../../services/runtime";
import { currentBackendConfig } from "../../services/release-guard";
import { ApiCutoutPort } from "./api";
import { DevSidecarCutoutPort, validateSidecarUrl } from "./dev-sidecar";
import { InMemoryCutoutPort } from "./fake";
import type { CutoutPort } from "./model";

let override: CutoutPort | null = null;
const byStore = new Map<string, CutoutPort>();
export function setCutoutPort(p: CutoutPort | null): void { override = p; byStore.clear(); }

/** Real adapter when an API base URL is configured; in-memory stand-in otherwise (never in a release build: the guard blocks first). */
export function getCutoutPort(storeId: string): CutoutPort {
  if (override !== null) return override;
  const hit = byStore.get(storeId);
  if (hit !== undefined) return hit;
  const apiBase = apiBaseUrlFromEnv();
  const cfg = currentBackendConfig(apiBase);
  let p: CutoutPort;
  const isDev = typeof __DEV__ !== "undefined" && __DEV__;
  const sidecar = isDev && apiBase === null ? validateSidecarUrl(process.env.EXPO_PUBLIC_DEV_CUTOUT_URL) : null;
  if (sidecar !== null) {
    p = new DevSidecarCutoutPort(sidecar);
  } else if (cfg.kind === "api") {
    const rt = getApiRuntime();
    p = rt === null ? new InMemoryCutoutPort({ outcome: "not_configured" }) : new ApiCutoutPort(createAdapterContext(rt), storeId);
  } else {
    // No API and no sidecar: an honest "not connected" port. The unchanged photo is never offered as a cutout.
    p = new InMemoryCutoutPort({ outcome: "not_configured" });
  }
  byStore.set(storeId, p);
  return p;
}
