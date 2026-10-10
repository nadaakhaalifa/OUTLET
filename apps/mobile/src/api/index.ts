import type { PrivacyClock as Clock } from "../workspace";
import { DevFakeApi } from "./dev-fake";
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
