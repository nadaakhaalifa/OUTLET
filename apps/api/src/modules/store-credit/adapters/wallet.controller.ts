import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { GetWallet, ListWalletTransactions } from "../application/queries";
import { GET_WALLET, LIST_WALLET_TRANSACTIONS } from "./tokens";
import { txnWire, walletWire } from "./wire";

const ListQuery = z
  .object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();
const CursorBody = z.object({ c: z.number().int().nonnegative().max(8.64e15), i: z.string().min(1).max(64) }).strict();

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

/**
 * Read-only by construction (ADR-0003): the wallet has no top-up, withdrawal or transfer route,
 * and a route-absence test keeps it so. The subject comes from the token only.
 */
@Controller("me/wallet")
export class WalletController {
  constructor(
    @Inject(GET_WALLET) private readonly getWallet: GetWallet,
    @Inject(LIST_WALLET_TRANSACTIONS) private readonly listTxns: ListWalletTransactions,
  ) {}

  @Get()
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async wallet(@Req() req: ApiRequest) {
    return walletWire(await this.getWallet.execute(userOf(req)));
  }

  @Get("transactions")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async transactions(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    const r = await this.listTxns.execute(userOf(req), decodeCursor(q.cursor), q.limit);
    const last = r.items[r.items.length - 1];
    return {
      items: r.items.map(txnWire),
      page: { next_cursor: r.hasMore && last !== undefined ? encodeCursor(last) : null, has_more: r.hasMore },
    };
  }
}

function userOf(req: ApiRequest): string {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p.actor.id;
}
