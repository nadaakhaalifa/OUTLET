import type { PrivacyClock as Clock } from "../workspace";
import { DevFakeApi } from "./dev-fake";
import { FakeAgeGate, type AgeGatePort } from "./age-gate";
import type { OutletApi } from "./port";

export type { OutletApi } from "./port";

/**
 * Chooses the API implementation. Only the development fixture exists; a release build refuses to
 * start with it rather than silently shipping fake data.
 */
export function createApi(clock: Clock, isDevelopment: boolean): OutletApi {
  if (!isDevelopment) throw new Error("No production API adapter exists yet; refusing to use the development fixture.");
  return new DevFakeApi({ clock });
}

/** Age-gate client. Development fake only until the HTTP adapter for POST /v1/auth/age-gate exists. */
export function createAgeGate(clock: Clock, isDevelopment: boolean): AgeGatePort {
  if (!isDevelopment) throw new Error("No production age-gate adapter exists yet; refusing to use the development fake.");
  return new FakeAgeGate({ clock });
}
