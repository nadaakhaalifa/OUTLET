import type { NextRequest } from "next/server";
import { handleProxy } from "../../../../../server/bff";
import { liveDeps, toBffRequest, toNextResponse } from "../../../../../server/bff-next";

export const dynamic = "force-dynamic";
interface Ctx {
  params: Promise<{ market: string; path: string[] }>;
}

async function run(req: NextRequest, { params }: Ctx) {
  const { market, path } = await params;
  return toNextResponse(await handleProxy(await toBffRequest(req), market, path, liveDeps()));
}
export const GET = run;
export const POST = run;
export const PATCH = run;
export const DELETE = run;
