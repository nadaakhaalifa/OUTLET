import { z } from "zod";

const envSchema = z.object({ SHOPPER_API_BASE_URL: z.string().url().optional() });

/** Base URL from env only. null means "not configured": pages render an honest unavailable state. */
export function readApiBaseUrl(env: Readonly<Record<string, string | undefined>>): string | null {
  const parsed = envSchema.safeParse({ SHOPPER_API_BASE_URL: env.SHOPPER_API_BASE_URL?.trim() || undefined });
  if (!parsed.success || parsed.data.SHOPPER_API_BASE_URL === undefined) return null;
  const u = new URL(parsed.data.SHOPPER_API_BASE_URL);
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !loopback) return null;
  return parsed.data.SHOPPER_API_BASE_URL;
}

/** Public origin used for canonical URLs, hreflang, sitemap and JSON-LD. */
export function readSiteUrl(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env.SHOPPER_SITE_URL?.trim();
  if (raw !== undefined && raw !== "") {
    try {
      const u = new URL(raw);
      const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol === "https:" || loopback) return u.origin;
    } catch {
      // fall through to the default
    }
  }
  return "http://localhost:3003";
}
