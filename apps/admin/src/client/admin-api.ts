/** Browser-side calls go through the same-origin BFF (/api/admin/{market}/...). The token cookie is HttpOnly; no secret reaches this code. */
export interface CallResult {
  readonly ok: boolean;
  readonly status: number;
  readonly code: string;
  readonly data: unknown;
}

interface CallBase {
  readonly body?: unknown;
  readonly reason?: string;
}
export interface ReadInit extends CallBase { readonly method?: "GET"; readonly idempotencyKey?: undefined }
/** A state-changing call must carry a client-generated UUIDv7 key (the API rejects other versions). */
export interface WriteInit extends CallBase {
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  readonly idempotencyKey: string;
}
export type CallInit = ReadInit | WriteInit;

export async function adminCall(market: string, path: string, init: CallInit = {}): Promise<CallResult> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.method !== undefined && init.method !== "GET") {
    headers["content-type"] = "application/json";
    if (init.idempotencyKey !== undefined) headers["idempotency-key"] = init.idempotencyKey;
  }
  if (init.reason !== undefined) headers["x-reason-code"] = init.reason;
  try {
    const res = await fetch(`/api/admin/${market}/${path}`, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}), cache: "no-store" });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      data = null;
    }
    const code = !res.ok && typeof data === "object" && data !== null && typeof (data as { code?: unknown }).code === "string" ? (data as { code: string }).code : res.ok ? "ok" : "unknown";
    return { ok: res.ok, status: res.status, code, data };
  } catch {
    return { ok: false, status: 503, code: "api-unavailable", data: null };
  }
}
