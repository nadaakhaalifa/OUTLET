import { tokensCss } from "../../styles/tokens-css";

// Static at build time. Served from the site origin so the strict style-src ('self') applies; no inline <style>.
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(tokensCss(), {
    headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" },
  });
}
