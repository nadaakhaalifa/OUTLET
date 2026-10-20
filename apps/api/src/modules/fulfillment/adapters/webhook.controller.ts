import { Controller, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { Public, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import type { IngestCourierWebhook } from "../application/webhooks";
import { INGEST_COURIER_WEBHOOK } from "./tokens";

const COURIER_CODE = /^[a-z0-9_-]{2,32}$/;

type RawBodyRequest = ApiRequest & { readonly rawBody?: Buffer };

function stringHeaders(req: ApiRequest): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

/**
 * `POST /v1/webhooks/couriers/{courier}`. Public route: authenticity is the courier HMAC over the
 * RAW body plus a timestamp window, verified before the body is parsed. The route fails closed
 * when the framework did not keep the raw bytes (the app must be created with `rawBody: true`).
 */
@Controller("webhooks/couriers")
export class CourierWebhookController {
  constructor(@Inject(INGEST_COURIER_WEBHOOK) private readonly ingest: IngestCourierWebhook) {}

  @Post(":courier")
  @Public()
  @HttpCode(200)
  @RateLimit([{ dimension: "ip", limit: 600, windowSeconds: 60 }])
  async receive(@Param("courier") courier: string, @Req() req: RawBodyRequest) {
    if (!COURIER_CODE.test(courier)) throw Problems.notFound();
    if (req.rawBody === undefined) {
      throw new ProblemError(503, "raw-body-unavailable", "The request body could not be verified", {
        code: "raw_body_unavailable",
      });
    }
    const result = await this.ingest.execute({
      courier,
      rawBody: req.rawBody.toString("utf8"),
      headers: stringHeaders(req),
    });
    switch (result.kind) {
      case "ok":
        return { received: true as const, duplicate: result.duplicate };
      case "unsupported_courier":
        throw Problems.notFound();
      case "too_large":
        throw new ProblemError(413, "payload-too-large", "The payload is too large", { code: "payload_too_large" });
      case "rejected":
        throw new ProblemError(401, "invalid-signature", "The signature could not be verified", {
          code: "invalid_signature",
        });
      case "bad_payload":
        throw Problems.malformedBody();
      case "conflict":
        throw Problems.unavailable("conflict_retry");
    }
  }
}
