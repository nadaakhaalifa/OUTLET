import type { MetadataRoute } from "next";
import { readEnv } from "../server/env";

// Decision D8: search and user-triggered assistant bots may crawl; model-training crawlers are blocked.
export const ALLOWED_BOTS = ["Googlebot", "Bingbot", "DuckDuckBot", "Applebot", "OAI-SearchBot", "PerplexityBot", "ChatGPT-User"] as const;
export const BLOCKED_BOTS = ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended", "Bytespider", "anthropic-ai", "Amazonbot"] as const;
const PRIVATE_PATHS = ["/*/bag", "/*/account"];

export default function robots(): MetadataRoute.Robots {
  const origin = readEnv().SITE_URL;
  return {
    rules: [
      ...ALLOWED_BOTS.map((userAgent) => ({ userAgent, allow: "/", disallow: PRIVATE_PATHS })),
      ...BLOCKED_BOTS.map((userAgent) => ({ userAgent, disallow: "/" })),
      { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
