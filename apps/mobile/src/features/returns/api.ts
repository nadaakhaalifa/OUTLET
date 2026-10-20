import { ApiError, dataOf } from "../../services/api-client";
import { bilingual, toPortError, unsupported, type AdapterContext } from "../../services/wire";
import type { ReturnCandidate, ReturnRequest, ReturnsPort } from "./model";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /v1/orders/lines/{id}/returns. */
export class ApiReturnsPort implements ReturnsPort {
  constructor(private readonly ctx: AdapterContext) {}

  /** There is no pre-submission eligibility endpoint (gap: operation + ReturnEligibility schema). */
  async load(_orderLineId: string): Promise<ReturnCandidate> {
    throw unsupported("returns eligibility preview (GET /v1/orders/lines/{id}/return-eligibility)");
  }

  async submit(request: ReturnRequest, idempotencyKey: string) {
    try {
      const r = dataOf(
        await this.ctx.client.createReturn(
          {
            path: { orderLineId: request.orderLineId },
            body: {
              qty: 1,
              reason: request.reason,
              resolution: request.resolution,
              method: request.method === "pickup" ? "pickup" : "drop_off",
              ...(request.resolution === "refund" && request.refundTarget !== null
                ? { refund_preference: request.refundTarget === "credit" ? ("store_credit" as const) : ("original_method" as const) }
                : {}),
              // Only ids that look like server upload ids are sent; the on-device fake upload port yields none (gap).
              ...(request.photoUploadIds !== undefined && request.photoUploadIds.length > 0 && request.photoUploadIds.every((id) => UUID.test(id))
                ? { photo_upload_ids: [...request.photoUploadIds] }
                : {}),
            },
          },
          { idempotencyKey },
        ),
      );
      return { ok: true as const, returnId: r.id };
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        return { ok: false as const, reason: bilingual({ ar: e.problem.detail ?? e.problem.title }) };
      }
      throw toPortError(e);
    }
  }
}
