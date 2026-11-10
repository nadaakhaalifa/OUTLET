import { z } from "zod";

const envSchema = z.object({
  CSP_TRUSTED_TYPES: z.enum(["on", "off"]).default("off"),
  /** Base URL of apps/api. Unset = every proxied call answers 503 (never fabricated data). */
  API_URL: z.url().optional(),
});

export type SellerEnv = z.infer<typeof envSchema>;

export function readEnv(source: Readonly<Record<string, string | undefined>> = process.env): SellerEnv {
  return envSchema.parse({
    ...(source.CSP_TRUSTED_TYPES !== undefined ? { CSP_TRUSTED_TYPES: source.CSP_TRUSTED_TYPES } : {}),
    ...(source.API_URL !== undefined && source.API_URL !== "" ? { API_URL: source.API_URL } : {}),
  });
}

/** HttpOnly cookie that holds the seller's access token (set by the sign-in flow, which lives outside this app for now). */
export const SESSION_COOKIE = "seller_session";
/** Active store (non-secret UUID) chosen in the store switcher; sent to the API as X-Store-Id. */
export const STORE_COOKIE = "seller_store";
/** Comma-separated store ids the signed-in user may switch between (written at sign-in; read-only here). */
export const STORES_COOKIE = "seller_stores";
