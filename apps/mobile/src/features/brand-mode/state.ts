/** Brand port container and the real `BrandModePort` (the Me tab's mode switcher contract lives in features/me/model.ts). */
import { router } from "expo-router";
import { getBrandModePort, setBrandModePort, type BrandModeEntry, type BrandModePort } from "../me/model";
import { apiBaseUrlFromEnv, createAdapterContext, getApiRuntime } from "../../services/runtime";
import { BackendNotConfiguredError, currentBackendConfig, currentDemoBrandAllowed } from "../../services/release-guard";
import { registerDevHint } from "../../services/dev-hints";
import { ApiBrandPort } from "./api";
import { InMemoryBrandPort } from "./fake";
import { createDemoBrandPort } from "./demo-brand";
import type { BrandPort } from "./model";

let current: BrandPort | null = null;

/** Real adapter when an API base URL is configured, in-memory fixture otherwise (never silently mixed). */
export function getBrandPort(): BrandPort {
  if (current !== null) return current;
  const cfg = currentBackendConfig(apiBaseUrlFromEnv());
  if (cfg.kind === "blocked") throw new BackendNotConfiguredError(cfg.reason); // never the fixture brand in release
  if (cfg.kind === "fixture") {
    current = new InMemoryBrandPort();
  } else {
    const rt = getApiRuntime();
    if (rt === null) throw new Error("EXPO_PUBLIC_API_BASE_URL is set but configureApiRuntime() has not run");
    current = new ApiBrandPort(createAdapterContext(rt));
  }
  return current;
}
export function setBrandPort(p: BrandPort | null): void {
  current = p;
  demoActive = false;
}

let demoActive = false;
/** Whether the dev-only "Sign in as demo brand" shortcut may be offered (never true in a release build or against a real API). */
export function demoBrandAvailable(): boolean {
  return currentDemoBrandAllowed(apiBaseUrlFromEnv());
}
/** Switches brand mode to the seeded "Nile Outlet" demo brand. Returns false (and changes nothing) unless the guard allows it. */
export function enterDemoBrand(): boolean {
  if (!demoBrandAvailable()) return false;
  if (!demoActive) {
    current = createDemoBrandPort();
    demoActive = true;
    registerDevHint("brand-demo", "Demo brand \"Nile Outlet\": seeded in-memory data (12 products, 6 orders). Sample numbers only; nothing is sent anywhere.");
  }
  return true;
}

/**
 * Entry for the Me tab. An account exists only for an APPROVED brand: the API port answers 403/404 for
 * anyone else (-> no entry). In development without a backend the fixture brand is offered so the mode is reachable.
 */
export class BrandModeFromBrandPort implements BrandModePort {
  async entry(): Promise<BrandModeEntry | null> {
    try {
      const a = await getBrandPort().account();
      return { brandId: a.storeId, name: a.name.en, status: "approved" };
    } catch {
      return null;
    }
  }
  enter(): void {
    router.push("/brand-mode");
  }
}

let registered = false;
/** Idempotent. Called once from the root layout; leaves any port another agent/test already set alone. */
export function registerBrandMode(): void {
  if (registered) return;
  registered = true;
  setBrandModePort(new BrandModeFromBrandPort());
}

/** Where a signed-in, onboarded user lands: approved brands go to brand mode (real backend only). */
export async function landingForSignedIn(): Promise<"/brand-mode" | null> {
  if (currentBackendConfig(apiBaseUrlFromEnv()).kind !== "api") return null;
  const entry = await getBrandModePort().entry();
  return entry !== null ? "/brand-mode" : null;
}

declare const process: { env: { EXPO_PUBLIC_SELLER_CENTER_URL?: string | undefined } };
/** Seller Center web URL from config (EXPO_PUBLIC_SELLER_CENTER_URL). Unset: null, except a clearly fake dev placeholder. */
export function sellerCenterUrl(): string | null {
  const v = process.env.EXPO_PUBLIC_SELLER_CENTER_URL;
  if (v !== undefined && v.trim().length > 0) return v.trim();
  return typeof __DEV__ !== "undefined" && __DEV__ ? "https://seller.z-outlet.example" : null;
}
