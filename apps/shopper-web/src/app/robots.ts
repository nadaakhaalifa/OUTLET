import type { MetadataRoute } from "next";
import { SITE } from "../lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/ar/cart", "/en/cart", "/ar/account", "/en/account", "/ar/checkout", "/en/checkout", "/ar/search?", "/en/search?"] }],
    sitemap: `${SITE}/sitemap.xml`,
    host: SITE,
  };
}
