import type { Transport, TransportRequest, TransportResponse } from "../api/transport";
import { NetworkError } from "../api/transport";

export type Handler = (req: TransportRequest) => TransportResponse | Promise<TransportResponse> | "network";

/** Route table keyed "METHOD /path" (query ignored). Records every request for assertions. */
export function fakeTransport(routes: Readonly<Record<string, Handler>>): Transport & { readonly calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      const h = routes[`${req.method} ${req.path}`];
      if (h === undefined) return { status: 404, headers: {}, json: { title: "no route" } };
      const out = await h(req);
      if (out === "network") throw new NetworkError("down");
      return out;
    },
  };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): TransportResponse => ({
  status,
  headers: { date: "Sun, 11 Oct 2026 10:00:00 GMT", ...headers },
  json: body,
});

export const UUID_A = "0f4c1c1e-2a55-4f7e-9d2b-1a2b3c4d5e6f";
export const UUID_B = "7a9d3c20-6b1e-4c11-8f33-0a1b2c3d4e5f";
export const UUID_C = "c1d2e3f4-0000-4000-8000-000000000001";
