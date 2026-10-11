import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest, ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { CancelDeletion, GetDeletion, RequestDeletion } from "../application/deletion";
import type { GetExport, RequestExport } from "../application/export";
import { DELETION_BLOCKER_KINDS, DELETION_BLOCKER_MESSAGES } from "../domain/bridge";
import {
  CANCEL_DELETION,
  EXPORT_RESOLVER,
  GET_DELETION,
  GET_EXPORT,
  REQUEST_DELETION,
  REQUEST_EXPORT,
} from "./tokens";
import { deletionWire, exportWire } from "./wire";

const IdParam = z.object({ exportId: z.uuid() }).strict();
const ExportBody = z.object({ locale: z.enum(["ar", "en"]).default("ar") }).strict();
const DeleteBody = z.object({ acknowledge_credit_forfeiture: z.boolean().default(false) }).strict();

function userIdOf(req: ApiRequest): string {
  const id = req.principal?.actor.id;
  if (id === undefined) throw Problems.unauthenticated();
  return id;
}

@Controller("me/privacy/export")
export class PrivacyExportController {
  constructor(
    @Inject(REQUEST_EXPORT) private readonly requestExport: RequestExport,
    @Inject(GET_EXPORT) private readonly getExport: GetExport,
  ) {}

  @Post()
  @HttpCode(202)
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 3600 }])
  async create(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Body(new ZodPipe(ExportBody)) body: z.infer<typeof ExportBody>,
  ) {
    const r = await this.requestExport.execute({ userId: userIdOf(req), locale: body.locale });
    if (r.kind === "existing") res.status(200);
    return exportWire(r.request, null);
  }

  @Get(":exportId")
  @Authorize({ action: "read", resourceType: "dsar_export", resolver: EXPORT_RESOLVER, idParam: "exportId" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async read(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
  ) {
    const v = await this.getExport.execute({ userId: userIdOf(req), id: params.exportId });
    if (v === null) throw Problems.notFound();
    res.setHeader("Cache-Control", "private, no-store");
    return exportWire(v.request, v.download);
  }
}

@Controller("me/privacy/delete")
export class PrivacyDeletionController {
  constructor(
    @Inject(REQUEST_DELETION) private readonly requestDeletion: RequestDeletion,
    @Inject(CANCEL_DELETION) private readonly cancelDeletion: CancelDeletion,
    @Inject(GET_DELETION) private readonly getDeletion: GetDeletion,
  ) {}

  @Post()
  @HttpCode(202)
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 3600 }])
  async create(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Body(new ZodPipe(DeleteBody)) body: z.infer<typeof DeleteBody>,
  ) {
    const r = await this.requestDeletion.execute({
      userId: userIdOf(req),
      acknowledgedForfeiture: body.acknowledge_credit_forfeiture,
    });
    switch (r.kind) {
      case "created":
        return deletionWire(r.request);
      case "existing":
        res.status(200);
        return deletionWire(r.request);
      case "blocked": {
        const counts = Object.fromEntries(
          DELETION_BLOCKER_KINDS.map((k) => [k, r.blockers.find((b) => b.kind === k)?.count ?? 0]),
        );
        throw new ProblemError(409, "deletion-blocked", "Account deletion is blocked", {
          code: "deletion_blocked",
          detail: r.blockers.map((b) => DELETION_BLOCKER_MESSAGES[b.kind].en).join(" "),
          extensions: {
            ...counts,
            blockers: r.blockers.map((b) => b.kind).join(","),
            message_ar: r.blockers.map((b) => DELETION_BLOCKER_MESSAGES[b.kind].ar).join(" "),
            message_en: r.blockers.map((b) => DELETION_BLOCKER_MESSAGES[b.kind].en).join(" "),
          },
        });
      }
      case "forfeiture_ack_required":
        throw new ProblemError(409, "forfeiture-acknowledgement-required", "Store credit would be forfeited", {
          code: "forfeiture_acknowledgement_required",
          extensions: { balance_amount: r.balanceMinor.toString(), balance_currency: "EGP" },
        });
    }
  }

  @Get()
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async current(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const r = await this.getDeletion.execute({ userId: userIdOf(req) });
    if (r === null) throw Problems.notFound();
    res.setHeader("Cache-Control", "private, no-store");
    return deletionWire(r);
  }

  @Delete()
  @HttpCode(200)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async cancel(@Req() req: ApiRequest) {
    const r = await this.cancelDeletion.execute({ userId: userIdOf(req) });
    switch (r.kind) {
      case "cancelled":
        return deletionWire(r.request);
      case "not_found":
        throw Problems.notFound();
      case "not_cancellable":
        throw new ProblemError(409, "deletion-not-cancellable", "The cooling period has ended", {
          code: "deletion_not_cancellable",
          extensions: { status: r.status },
        });
      case "conflict":
        throw new ProblemError(409, "deletion-conflict", "The request changed; reload and retry", {
          code: "deletion_conflict",
        });
    }
  }
}
