/**
 * The ONLY module in the app that may call fetch (enforced by a test in boundaries.test.ts).
 * Everything else depends on the Transport interface so tests and the offline build never touch the network.
 */
export interface TransportRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly responseType?: "json" | "binary";
}

export interface TransportResponse {
  readonly status: number;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly bytes?: ArrayBuffer;
}

export interface Transport {
  send(req: TransportRequest, signal?: AbortSignal): Promise<TransportResponse>;
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export function createFetchTransport(options: { baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Transport {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async send(req, signal) {
      const url = new URL(base + req.path);
      for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
      const headers: Record<string, string> = { accept: req.responseType === "binary" ? "application/pdf" : "application/json", ...req.headers };
      let body: string | undefined;
      if (req.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(req.body);
      }
      const timeout = AbortSignal.timeout(timeoutMs);
      const signals = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      let res: Response;
      try {
        res = await doFetch(url, {
          method: req.method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: signals,
          cache: "no-store",
          credentials: "omit",
        });
      } catch (e) {
        throw new NetworkError(e instanceof Error ? e.message : "network");
      }
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        outHeaders[k.toLowerCase()] = v;
      });
      if (req.responseType === "binary" && res.ok) {
        return { status: res.status, headers: outHeaders, bytes: await res.arrayBuffer() };
      }
      const text = await res.text();
      let json: unknown;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      return { status: res.status, headers: outHeaders, ...(json === undefined ? {} : { json }) };
    },
  };
}

/**
 * One-shot GET of a signed image link for the same-origin relay (/media/file). No credentials, no redirects, 10 s cap.
 * Returns null on any failure so the caller can answer 502 without leaking the storage host.
 */
export async function fetchImage(url: URL, maxBytes: number): Promise<{ type: string; bytes: ArrayBuffer } | null> {
  try {
    const r = await fetch(url, { redirect: "error", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength > maxBytes) return null;
    return { type: r.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "", bytes };
  } catch {
    return null;
  }
}
