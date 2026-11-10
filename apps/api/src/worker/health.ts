import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunnerStatus } from "./runner.js";

export interface WorkerHealth {
  /** False once a loop missed its heartbeat for longer than the liveness budget, or after stop. */
  readonly live: boolean;
  readonly draining: boolean;
  readonly schedulerLastTickAt: string | null;
  readonly markets: readonly RunnerStatus[];
}

export interface HealthServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Health endpoint on its own port (ADR-0016), never on the API port: `GET /livez` is 200 or 503 for the orchestrator's liveness probe;
 * `GET /healthz` returns the full status (relay and per-consumer kill state, pending count, lag in seconds) as JSON with the same status code.
 * The body carries job names, counts, timestamps and error codes only: no event ids, payloads or personal data.
 */
export const startHealthServer = (opts: { readonly host: string; readonly port: number; readonly health: () => WorkerHealth }): Promise<HealthServer> => {
  const route = (method: string | undefined, url: string | undefined): readonly [number, unknown] => {
    if (method !== "GET") return [405, { status: "method_not_allowed" }];
    const h = opts.health();
    const code = h.live ? 200 : 503;
    if (url === "/livez") return [code, { status: h.live ? "ok" : "unhealthy", draining: h.draining }];
    if (url !== "/healthz") return [404, { status: "not_found" }];
    return [
      code,
      {
        status: h.live ? "ok" : "unhealthy",
        draining: h.draining,
        scheduler: { last_tick_at: h.schedulerLastTickAt },
        markets: h.markets.map((m) => ({
          market_id: m.marketId,
          relay: { killed: m.relayKilled, last_poll_at: m.lastPollAt, last_error: m.lastError },
          consumers: m.consumers.map((c) => ({ job: c.job, killed: c.killed, pending: c.pending, lag_seconds: c.lagSeconds })),
          // Pending types no consumer of this process claims (never acked): a consumer still has to be composed for them.
          unrouted: m.unrouted === null ? null : { pending: m.unrouted.pending, lag_seconds: m.unrouted.lagSeconds, types: m.unrouted.types },
        })),
      },
    ];
  };
  const server: Server = createServer((req, res) => {
    const [status, body] = route(req.method, req.url);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((r) => { server.close(() => { r(); }); server.closeAllConnections(); }),
      });
    });
  });
};
