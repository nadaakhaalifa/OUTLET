import { ApiError, type OutletClient, type schemas } from "../../services/api-client";
import type { MergeHttpResult, MergeTransport } from "./merge";

/** POST /v1/me/guest-merge with the caller's Idempotency-Key. Failures become a status; nothing throws. */
export class ApiMergeTransport implements MergeTransport {
  constructor(private readonly client: OutletClient) {}

  async merge(body: schemas.GuestMergeRequest, idempotencyKey: string): Promise<MergeHttpResult> {
    try {
      const r = await this.client.mergeGuest({ body }, { idempotencyKey });
      if (r.notModified) return { status: 0, data: null };
      return { status: 200, data: r.data };
    } catch (e) {
      return { status: e instanceof ApiError ? e.status : 0, data: null };
    }
  }
}
