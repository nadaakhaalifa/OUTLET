import { Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { JoinQueue } from "../application/join";
import type { QueueStatus } from "../application/status";
import { JOIN_QUEUE, QUEUE_STATUS } from "./tokens";

const DropParams = z.object({ dropId: z.uuid() }).strict();
const DeviceId = z.string().min(8).max(128);

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};

const deviceOf = (req: ApiRequest): string => {
  const parsed = DeviceId.safeParse(headerValue(req, "x-device-id"));
  if (!parsed.success) throw Problems.validation([{ pointer: "/headers/x-device-id", code: "required" }]);
  return parsed.data;
};

const refuse = (status: number, code: string, title: string): ProblemError =>
  new ProblemError(status, code.replaceAll("_", "-"), title, { code });

@Controller()
export class WaitingRoomController {
  constructor(
    @Inject(JOIN_QUEUE) private readonly join: JoinQueue,
    @Inject(QUEUE_STATUS) private readonly status: QueueStatus,
  ) {}

  /** The queue is keyed by the token subject: there is no foreign object id to confuse (no BOLA). */
  @Post("drops/:dropId/queue")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 3, windowSeconds: 60 }])
  async joinQueue(@Req() req: ApiRequest, @Param(new ZodPipe(DropParams, "/params")) p: { dropId: string }) {
    const r = await this.join.execute({
      userId: principalOf(req).actor.id,
      dropId: p.dropId.toLowerCase(),
      deviceId: deviceOf(req),
      attestToken: headerValue(req, "x-app-attest") ?? null,
    });
    switch (r.kind) {
      case "queued":
        return { ticket_id: r.ticketId, state: r.state, position: r.position, resumed: r.resumed };
      case "not_found":
        throw Problems.notFound();
      case "paused":
        throw Problems.unavailable(r.reason === "drop_paused" ? "drop_paused" : "drops_paused");
      case "refused":
        if (r.code === "plus_required") throw refuse(403, "plus_required", "Early access is for HAUL Plus members");
        if (r.code === "sold_out") throw refuse(409, "sold_out", "This drop is sold out");
        if (r.code === "not_open") throw refuse(409, "not_open", "This drop has not opened yet");
        throw refuse(409, "drop_closed", "This drop is closed");
      case "attestation_failed":
        throw refuse(403, "attestation_failed", "Device attestation failed");
      case "bot_blocked":
        throw refuse(403, "bot_blocked", "Request blocked");
      case "challenge_required":
        throw refuse(403, "challenge_required", "Additional verification is required");
      case "device_busy":
        throw refuse(409, "device_has_active_ticket", "This device already holds a place in the queue");
    }
  }

  @Get("drops/:dropId/queue/status")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 1, windowSeconds: 1 }])
  async queueStatus(@Req() req: ApiRequest, @Param(new ZodPipe(DropParams, "/params")) p: { dropId: string }) {
    const r = await this.status.execute({ userId: principalOf(req).actor.id, dropId: p.dropId.toLowerCase() });
    switch (r.kind) {
      case "waiting":
        return { state: "waiting", position: r.position, eta_seconds: r.etaSeconds };
      case "admitted":
        return { state: "admitted", admission_token: r.token, expires_at: new Date(r.expiresAtMs).toISOString() };
      case "not_queued":
        return { state: "not_queued", admission_expired: r.admissionExpired };
      case "not_found":
        throw Problems.notFound();
      case "paused":
        throw Problems.unavailable("drops_paused");
    }
  }
}
