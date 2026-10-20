import { z } from "zod";

const envSchema = z.object({ ADMIN_API_BASE_URL: z.string().url().optional() });

/** Base URL comes from env only. null means "not configured": screens show an honest error state, never sample data. */
export function readApiBaseUrl(env: Readonly<Record<string, string | undefined>>): string | null {
  const parsed = envSchema.safeParse({ ADMIN_API_BASE_URL: env.ADMIN_API_BASE_URL?.trim() || undefined });
  if (!parsed.success) return null;
  const url = parsed.data.ADMIN_API_BASE_URL;
  if (url === undefined) return null;
  const u = new URL(url);
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !loopback) return null;
  return url;
}

/**
 * Origin of the document store that serves signed read URLs (img-src / frame-src in the CSP). Env only, https only
 * (loopback allowed for local runs). null means the viewer stays disabled: we never widen the CSP to a guess.
 */
export function readDocumentOrigin(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = env.ADMIN_DOCUMENT_ORIGIN?.trim();
  if (raw === undefined || raw === "") return null;
  try {
    const u = new URL(raw);
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return u.protocol === "https:" || (loopback && u.protocol === "http:") ? u.origin : null;
  } catch {
    return null;
  }
}
