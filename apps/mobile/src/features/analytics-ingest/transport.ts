import type { IngestOutcome, IngestRequest, IngestTransport } from "./emitter";

export type FetchFn = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;

export interface FetchTransportDeps {
  readonly baseUrl: string;
  readonly bearer: () => Promise<string | null>;
  readonly fetch: FetchFn;
}

/**
 * POST /v1/analytics/events over fetch. Interim adapter behind IngestTransport until the regenerated
 * api-client exposes `ingestAnalyticsEvents`; swap it then, nothing else changes. Sends X-App-Attest,
 * X-Client-Platform and the per-batch Idempotency-Key; never sends a user id.
 */
export class FetchIngestTransport implements IngestTransport {
  constructor(private readonly deps: FetchTransportDeps) {}

  async send(req: IngestRequest): Promise<IngestOutcome> {
    const bearer = await this.deps.bearer();
    if (bearer === null) return { kind: "rejected" };
    try {
      const res = await this.deps.fetch(`${this.deps.baseUrl.replace(/\/+$/, "")}/v1/analytics/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
          "X-App-Attest": req.attest,
          "X-Client-Platform": req.platform,
          "Idempotency-Key": req.idempotencyKey,
        },
        body: JSON.stringify(req.body),
      });
      return classify(res.status);
    } catch {
      return { kind: "retry" };
    }
  }
}

export function classify(status: number): IngestOutcome {
  if (status === 202 || status === 200) return { kind: "accepted" };
  if (status === 503) return { kind: "disabled" };
  if (status === 429 || status >= 500) return { kind: "retry" };
  return { kind: "rejected" };
}
