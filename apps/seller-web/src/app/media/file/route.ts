import { z } from "zod";
import { isMediaFile, RELAYED_TYPES } from "../../../view-models/product-media";
import { fetchImage } from "../../../api/transport";
import { readApiBaseUrl } from "../../../api/config";
import { getContext } from "../../../server-context";

const Q = z.object({ job: z.string().uuid(), kind: z.string() });
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * Same-origin relay for private product photos. The signed storage link (<= 15 min) is fetched server-side with the
 * seller's session-scoped job lookup and streamed back as an image: the browser never sees it, and CSP img-src stays 'self'.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = Q.safeParse({ job: url.searchParams.get("job"), kind: url.searchParams.get("kind") });
  if (!q.success || !isMediaFile(q.data.kind)) return new Response(null, { status: 400 });
  const { api } = await getContext();
  if (api === null) return new Response(null, { status: 503 });
  const store = await api.store();
  if (!store.ok) return new Response(null, { status: store.error.status === 401 ? 401 : 404 });
  const job = await api.productMediaJob(store.value.data.id, q.data.job);
  if (!job.ok) return new Response(null, { status: job.error.status === 401 ? 401 : 404 });
  const link = job.value.data.links[q.data.kind];
  if (link === null) return new Response(null, { status: 404 });
  let target: URL;
  try { target = new URL(link.url); } catch { return new Response(null, { status: 502 }); }
  // https only, except the configured API's own origin (the local fixture gateway serves its sample images over http).
  const base = readApiBaseUrl(process.env);
  const apiOrigin = base === null ? null : new URL(base).origin;
  if (target.protocol !== "https:" && target.origin !== apiOrigin) return new Response(null, { status: 502 });
  const img = await fetchImage(target, MAX_BYTES);
  if (img === null || !RELAYED_TYPES.has(img.type)) return new Response(null, { status: 502 });
  const buf = img.bytes;
  const type = img.type;
  return new Response(buf, { headers: { "Content-Type": type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" } });
}
