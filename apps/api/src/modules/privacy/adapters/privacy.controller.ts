import { Body, Controller, Get, HttpCode, Inject, Patch, Req, Res } from "@nestjs/common";
import { CONSENT_PURPOSES } from "@outlet/privacy";
import { sha256Hex } from "@outlet/idempotency";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { ConsentState, GetConsents, UpdateConsents } from "../application/consents";
import { GET_CONSENTS, UPDATE_CONSENTS } from "./tokens";

const PolicyVersion = z
  .string()
  .regex(/^[1-9][0-9]{0,4}$/, "policy_version must be a positive integer string")
  .transform(Number);

const ConsentUpdateSchema = z
  .object({
    changes: z
      .array(
        z
          .object({
            purpose: z.enum(CONSENT_PURPOSES),
            granted: z.boolean(),
            policy_version: PolicyVersion,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

function toWire(state: ConsentState) {
  return {
    consents: state.consents.map((c) => ({
      purpose: c.purpose,
      granted: c.granted,
      updated_at: c.updatedAt,
      policy_version: String(c.policyVersion),
    })),
  };
}

function etagOf(wire: unknown): string {
  return `"${sha256Hex(JSON.stringify(wire)).slice(0, 32)}"`;
}

function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(",").some((t) => t.trim() === etag || t.trim() === `W/${etag}` || t.trim() === "*");
}

@Controller("me/privacy/consents")
export class PrivacyController {
  constructor(
    @Inject(GET_CONSENTS) private readonly getConsents: GetConsents,
    @Inject(UPDATE_CONSENTS) private readonly updateConsents: UpdateConsents,
  ) {}

  @Get()
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async read(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const userId = req.principal?.actor.id;
    if (userId === undefined) throw Problems.unauthenticated();
    const wire = toWire(await this.getConsents.execute(userId));
    const etag = etagOf(wire);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    if (matchesIfNoneMatch(headerValue(req, "if-none-match"), etag)) {
      throw new ProblemError(304, "not-modified", "Not modified");
    }
    return wire;
  }

  @Patch()
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async update(
    @Req() req: ApiRequest,
    @Body(new ZodPipe(ConsentUpdateSchema)) body: z.infer<typeof ConsentUpdateSchema>,
  ) {
    const userId = req.principal?.actor.id;
    if (userId === undefined) throw Problems.unauthenticated();
    const result = await this.updateConsents.execute({
      userId,
      ip: req.ip ?? "unknown",
      changes: body.changes.map((c) => ({ purpose: c.purpose, granted: c.granted, version: c.policy_version })),
    });
    switch (result.kind) {
      case "ok":
        return toWire(result.state);
      case "duplicate_purpose":
        throw new ProblemError(422, "duplicate-purpose", "A purpose may appear once per request", {
          code: "duplicate_purpose",
          extensions: { purpose: result.purpose },
        });
      case "unknown_version":
        throw new ProblemError(422, "consent-version-unknown", "That consent text version does not exist", {
          code: "consent_version_unknown",
          extensions: { purpose: result.purpose, current_policy_version: String(result.currentVersion) },
        });
      case "stale_version":
        throw new ProblemError(422, "consent-version-stale", "The consent text has changed; show the current version", {
          code: "consent_version_stale",
          extensions: { purpose: result.purpose, current_policy_version: String(result.currentVersion) },
        });
    }
  }
}
