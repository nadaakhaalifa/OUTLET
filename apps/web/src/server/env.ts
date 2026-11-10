import { z } from "zod";

const envSchema = z.object({
  /** Public origin used for canonical URLs, sitemap and JSON-LD. Must be set in every deployed environment. */
  SITE_URL: z.url().default("http://localhost:3000"),
  CSP_TRUSTED_TYPES: z.enum(["on", "off"]).default("off"),
  /** Base URL of apps/api. Unset = Unconfigured client (empty results, never fabricated data). */
  API_URL: z.url().optional(),
});

export type WebEnv = z.infer<typeof envSchema>;

export function readEnv(source: Readonly<Record<string, string | undefined>> = process.env): WebEnv {
  return envSchema.parse({
    ...(source.SITE_URL !== undefined && source.SITE_URL !== "" ? { SITE_URL: source.SITE_URL } : {}),
    ...(source.CSP_TRUSTED_TYPES !== undefined ? { CSP_TRUSTED_TYPES: source.CSP_TRUSTED_TYPES } : {}),
    ...(source.API_URL !== undefined && source.API_URL !== "" ? { API_URL: source.API_URL } : {}),
  });
}
