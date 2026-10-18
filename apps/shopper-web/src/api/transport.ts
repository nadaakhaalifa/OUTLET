import { createClient, type OutletClient } from "@outlet/api-client";
import { readApiBaseUrl } from "./config";

/** Seconds a fetched API response may be reused by the Next data cache (ISR staleness bound; spec P3-06 rules). */
export const REVALIDATE_SECONDS = 60;

/**
 * The only module that touches the network. Public reads carry no credentials and no cookies, so pages stay
 * cacheable and contain no personal data. Responses are cached with a short revalidate window.
 */
export function publicClient(env: Readonly<Record<string, string | undefined>> = process.env): OutletClient | null {
  const baseUrl = readApiBaseUrl(env);
  if (baseUrl === null) return null;
  return createClient({
    baseUrl,
    timeoutMs: 5_000,
    maxRetries: 1,
    getHeaders: () => ({ Accept: "application/json" }),
    fetch: (input, init) =>
      fetch(input, { ...init, credentials: "omit", next: { revalidate: REVALIDATE_SECONDS, tags: ["public-catalog"] } }),
  });
}
