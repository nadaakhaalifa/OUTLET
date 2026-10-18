/**
 * Own port container for the brand flow (kept out of state/ports.ts so parallel agents do not collide).
 * Real adapter when EXPO_PUBLIC_API_BASE_URL is set, in-memory fake otherwise. Tests override with setBrandApply().
 */
import { ApiBrandApplyPort } from "./api";
import { InMemoryBrandApplyPort } from "./fake";
import type { BrandApplyPort, FilePickerPort, PasskeyPort } from "./model";
import { DevicePicker } from "./picker";
import { UnsupportedPasskey } from "./passkey";
import { apiBaseUrlFromEnv, getApiRuntime } from "../../services/runtime";
import { registerDevHint } from "../../services/dev-hints";
import { BackendNotConfiguredError, currentBackendConfig } from "../../services/release-guard";

export interface BrandApplyKit { readonly port: BrandApplyPort; readonly passkey: PasskeyPort; readonly picker: FilePickerPort; readonly isFake: boolean }

let current: BrandApplyKit | null = null;

export function createBrandApplyKit(baseUrl: string | null = apiBaseUrlFromEnv()): BrandApplyKit {
  const cfg = currentBackendConfig(baseUrl);
  if (cfg.kind === "blocked") throw new BackendNotConfiguredError(cfg.reason);
  if (cfg.kind === "fixture") registerDevHint("brand-apply", "Brand application: nothing is sent to a server. The code for every verification is 123456. The sample-document source is available through the fake picker only.");
  if (cfg.kind === "fixture") return { port: new InMemoryBrandApplyPort(), passkey: new UnsupportedPasskey(), picker: new DevicePicker(true), isFake: true };
  const rt = getApiRuntime();
  if (rt === null) throw new Error("EXPO_PUBLIC_API_BASE_URL is set but configureApiRuntime() has not run");
  return { port: new ApiBrandApplyPort(rt), passkey: new UnsupportedPasskey(), picker: new DevicePicker(false), isFake: false };
}
export function getBrandApply(): BrandApplyKit { if (current === null) current = createBrandApplyKit(); return current; }
export function setBrandApply(k: BrandApplyKit | null): void { current = k; }
