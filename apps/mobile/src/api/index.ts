import type { PrivacyClock as Clock } from "../workspace";
import { DevFakeApi } from "./dev-fake";
import { FakeAgeGate, type AgeGatePort } from "./age-gate";
import type { OutletApi } from "./port";
import { HttpAgeGate, HttpOutletApi } from "../services/http-api";
import { getSharedClient, type ApiRuntime } from "../services/runtime";

export type { OutletApi } from "./port";

/**
 * Chooses the API implementation. With an API runtime (EXPO_PUBLIC_API_BASE_URL set) the generated HTTP client
 * is used in every build. Without one only the development fixture exists, and a release build refuses to
 * start with it rather than silently shipping fake data.
 */
export function createApi(clock: Clock, isDevelopment: boolean, runtime?: ApiRuntime | null): OutletApi {
  if (runtime !== undefined && runtime !== null) return new HttpOutletApi(getSharedClient(runtime), runtime.installId, runtime.platform, clock);
  if (!isDevelopment) throw new Error("EXPO_PUBLIC_API_BASE_URL is not set; refusing to use the development fixture in a release build.");
  return new DevFakeApi({ clock });
}

/** Age-gate client: POST /v1/auth/age-gate with an API runtime, the development fake otherwise (never in release). */
export function createAgeGate(clock: Clock, isDevelopment: boolean, runtime?: ApiRuntime | null): AgeGatePort {
  if (runtime !== undefined && runtime !== null) return new HttpAgeGate(getSharedClient(runtime));
  if (!isDevelopment) throw new Error("EXPO_PUBLIC_API_BASE_URL is not set; refusing to use the development fake in a release build.");
  return new FakeAgeGate({ clock });
}
