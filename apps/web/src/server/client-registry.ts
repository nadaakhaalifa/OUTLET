import type { ApiClient } from "./api-client";
import { UnconfiguredApiClient } from "./api-client";
import { readEnv } from "./env";
import { HttpApiClient } from "./http-api-client";

// Composition root for the server data layer. Kept out of api-client.ts so the
// types module has no runtime dependency on the HTTP implementation (no import cycle).
let client: ApiClient | null = null;
export function getApiClient(): ApiClient {
  if (client === null) {
    const base = readEnv().API_URL;
    client = base === undefined ? new UnconfiguredApiClient() : new HttpApiClient(base);
  }
  return client;
}
/** Test seam and composition root. */
export function setApiClient(next: ApiClient | null): void {
  client = next;
}
