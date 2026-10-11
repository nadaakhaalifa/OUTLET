import { z } from "zod";
import { getContext } from "../../../../server-context";

export const dynamic = "force-dynamic";

/** Streams the A6 AWB label PDF through the server so the bearer token never reaches the browser. */
export async function GET(_req: Request, ctx: { params: Promise<{ shipmentId: string }> }): Promise<Response> {
  const id = z.string().uuid().safeParse((await ctx.params).shipmentId);
  if (!id.success) return new Response(null, { status: 404 });
  const { api } = await getContext();
  if (api === null) return new Response(null, { status: 503 });
  const r = await api.shipmentLabel(id.data);
  if (!r.ok) {
    const status = r.error.kind === "unauthorized" ? 401 : r.error.kind === "forbidden" ? 403 : r.error.kind === "not_found" ? 404 : 502;
    return new Response(null, { status });
  }
  return new Response(r.value.data, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="awb-${id.data}.pdf"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
