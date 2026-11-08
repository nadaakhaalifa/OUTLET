import { cookies, headers as nextHeaders } from "next/headers";
import type { NextRequest } from "next/server";
import { passResponse, planProxy, problemResponse } from "../../../../server/bff";
import { readEnv } from "../../../../server/env";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const body = req.method === "GET" ? null : await req.arrayBuffer();
  const plan = planProxy({
    method: req.method,
    segments: path,
    search: req.nextUrl.search,
    headers: await nextHeaders(),
    cookies: await cookies(),
    body,
    apiUrl: readEnv().API_URL,
  });
  if (plan.kind === "reject") return problemResponse(plan.status, plan.code);
  try {
    return await passResponse(await fetch(plan.url, { ...plan.init, signal: AbortSignal.timeout(15_000), cache: "no-store" }));
  } catch {
    return problemResponse(503, "api-unavailable");
  }
}

export { handle as GET, handle as POST, handle as PATCH };
