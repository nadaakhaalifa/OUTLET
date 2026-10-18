import { Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import type { Clock, IdGenerator } from "../../../platform/ports";
import { ProblemError, Problems } from "../../../platform/problem";
import { CLOCK, ID_GENERATOR } from "../../../platform/tokens";
import type { IngestAnalyticsBatch } from "../application/ingest-batch";
import { MAX_BODY_BYTES } from "../domain/client-events";
import {
  AttestationRequiredError,
  IngestDisabledError,
  IngestRateLimitedError,
  IngestStoreUnavailableError,
  InvalidBatchError,
  PlausibilityUnavailableError,
} from "../domain/ports";
import { ANALYTICS_INGEST_USE_CASE } from "./tokens";

/**
 * `POST /v1/analytics/events` (dashboard foundations track 5). Shopper (buyer_api) tokens only; a
 * seller or admin token is rejected by the audience check before this runs. Rate limits are keyed on
 * the user and the verified session, never on the unattested client install id (H2).
 */
@Controller("analytics")
export class AnalyticsIngestController {
  constructor(
    @Inject(ANALYTICS_INGEST_USE_CASE) private readonly ingest: IngestAnalyticsBatch,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post("events")
  @HttpCode(202)
  @AuthenticatedSelf("buyer_api")
  @Idempotent({ required: true })
  @RateLimit([
    { dimension: "session", limit: 60, windowSeconds: 60 },
    { dimension: "user", limit: 120, windowSeconds: 60 },
  ])
  async events(@Req() req: ApiRequest, @Body() body: unknown) {
    const principal = req.principal;
    if (principal === null || principal === undefined) throw Problems.unauthenticated();
    if (byteLength(body) > MAX_BODY_BYTES) {
      throw new ProblemError(413, "payload-too-large", "Request body is too large", { code: "payload_too_large" });
    }
    const platform = headerValue(req, "x-client-platform");
    const token = headerValue(req, "x-app-attest");
    try {
      return await this.ingest.execute({
        userId: principal.actor.id,
        attestation: (platform === "ios" || platform === "android") && token !== undefined && token.length > 0 ? { platform, token } : null,
        body,
        nowMs: this.clock.nowMs(),
        batchId: this.ids.uuidV7(),
      });
    } catch (e) {
      if (e instanceof IngestDisabledError) throw Problems.unavailable("analytics_ingest_disabled");
      if (e instanceof AttestationRequiredError) throw Problems.unauthenticated("attestation_required");
      if (e instanceof InvalidBatchError) {
        throw e.code === "forbidden_property"
          ? new ProblemError(400, "forbidden-property", "The request contains a property that must never be sent", { code: "forbidden_property" })
          : Problems.validation([{ pointer: "/body", code: e.code }]);
      }
      if (e instanceof IngestRateLimitedError) throw Problems.rateLimited(e.retryAfterSeconds);
      if (e instanceof PlausibilityUnavailableError) throw Problems.unavailable("analytics_plausibility_unavailable");
      if (e instanceof IngestStoreUnavailableError) throw Problems.unavailable("analytics_ingest_unavailable");
      throw e;
    }
  }
}

function byteLength(body: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(body) ?? "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
