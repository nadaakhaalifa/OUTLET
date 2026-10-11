import { z } from "zod";

const envSchema = z.object({ SELLER_API_BASE_URL: z.string().url().optional() });

/** Base URL comes from env only. Undefined means "not configured": screens show an honest error state. */
export function readApiBaseUrl(env: Readonly<Record<string, string | undefined>>): string | null {
  const parsed = envSchema.safeParse({ SELLER_API_BASE_URL: env.SELLER_API_BASE_URL?.trim() || undefined });
  if (!parsed.success) return null;
  const url = parsed.data.SELLER_API_BASE_URL;
  if (url === undefined) return null;
  // Production must be https; http only for loopback development.
  const u = new URL(url);
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !loopback) return null;
  return url;
}
