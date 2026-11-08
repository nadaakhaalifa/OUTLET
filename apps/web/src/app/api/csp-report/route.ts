import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { MAX_REPORT_BYTES, handleCspReport } from "../../../server/csp-report";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const declared = Number(req.headers.get("content-length") ?? "0");
  const body = Number.isFinite(declared) && declared > MAX_REPORT_BYTES ? "" : (await req.text()).slice(0, MAX_REPORT_BYTES + 1);
  const r = handleCspReport({ method: "POST", contentType: req.headers.get("content-type"), body }, { now: Date.now, log: (l) => { console.warn(l); } });
  return new NextResponse(null, { status: r.status, headers: { "cache-control": "no-store" } });
}
