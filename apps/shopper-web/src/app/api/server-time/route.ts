// Server clock for countdowns. Never cached; carries no user data.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ now: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}
