import { z } from "zod";

const envSchema = z.object({
  CSP_TRUSTED_TYPES: z.enum(["on", "off"]).default("off"),
  /** Base URL of apps/api. Unset = every proxied call answers 503 (never fabricated data). */
  API_URL: z.url().optional(),
});

export type AdminEnv = z.infer<typeof envSchema>;

export function readEnv(source: Readonly<Record<string, string | undefined>> = process.env): AdminEnv {
  return envSchema.parse({
    ...(source.CSP_TRUSTED_TYPES !== undefined ? { CSP_TRUSTED_TYPES: source.CSP_TRUSTED_TYPES } : {}),
    ...(source.API_URL !== undefined && source.API_URL !== "" ? { API_URL: source.API_URL } : {}),
  });
}

/** HttpOnly cookie with the staff bearer token (set by the BFF after the passkey ceremony; the browser never reads it). */
export const SESSION_COOKIE = "admin_session";
/** HttpOnly cookie with the non-secret session summary (roles, amr, expiry) used only to render the shell. The API decides authorization. */
export const PROFILE_COOKIE = "admin_profile";
