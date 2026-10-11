import { Controller, Get, Inject, Param, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { GetMyRefund, ListMyRefunds } from "../application/queries";
import { GET_MY_REFUND, LIST_MY_REFUNDS } from "./tokens";
import { refundWire } from "./wire";

const IdParam = z.object({ id: z.uuid() }).strict();
const ListQuery = z
  .object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();
const CursorBody = z.object({ c: z.number().int().nonnegative().max(8.64e15), i: z.uuid() }).strict();

function decodeCursor(raw: string | undefined): { createdAtMs: number; id: string } | null {
  if (raw === undefined) return null;
  try {
    const p = CursorBody.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return { createdAtMs: p.c, id: p.i };
  } catch {
    throw Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);
  }
}
const encodeCursor = (c: { createdAtMs: number; id: string }): string =>
  Buffer.from(JSON.stringify({ c: c.createdAtMs, i: c.id })).toString("base64url");

function userOf(req: ApiRequest): string {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p.actor.id;
}

/**
 * Shopper read side only. Refunds are created from `return.refund_intent` events, never by an
 * HTTP write, so a client cannot mint or redirect a refund. A refund of another shopper is a 404.
 */
@Controller()
export class RefundsController {
  constructor(
    @Inject(GET_MY_REFUND) private readonly getRefund: GetMyRefund,
    @Inject(LIST_MY_REFUNDS) private readonly listRefunds: ListMyRefunds,
  ) {}

  @Get("me/refunds")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async list(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    const r = await this.listRefunds.execute(userOf(req), decodeCursor(q.cursor), q.limit);
    const last = r.items[r.items.length - 1];
    return {
      items: r.items.map(refundWire),
      page: { next_cursor: r.hasMore && last !== undefined ? encodeCursor({ createdAtMs: last.refund.requestedAtMs, id: last.refund.id }) : null, has_more: r.hasMore },
    };
  }

  @Get("refunds/:id")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async one(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    const v = await this.getRefund.execute(userOf(req), p.id);
    if (v === null) throw Problems.notFound();
    return refundWire(v);
  }
}
