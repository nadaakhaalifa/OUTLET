import type { NextRequest } from "next/server";
import { handleAuth } from "../../../../../server/bff";
import { liveDeps, toBffRequest, toNextResponse } from "../../../../../server/bff-next";

export const dynamic = "force-dynamic";
interface Ctx {
  params: Promise<{ market: string; action: string }>;
}

async function run(req: NextRequest, { params }: Ctx) {
  const { market, action } = await params;
  return toNextResponse(await handleAuth(await toBffRequest(req), market, action, liveDeps()));
}
export const GET = run;
export const POST = run;
