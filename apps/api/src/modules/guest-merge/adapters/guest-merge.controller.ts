import { Body, Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { GUEST_MERGE_LIMITS } from "@outlet/domain";
import { z } from "zod";
import { cartWire } from "../../cart";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest, ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { assertGuestBrowsingEnabled, type PublicReadGate } from "../../../platform/public-read";
import { GUEST_BROWSING_GATE } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { MergeGuest } from "../application/merge-guest";
import { GuestCatalogUnavailableError, GUEST_SAVED_INTENTS, MergeConflictError } from "../domain/ports";
import { MERGE_GUEST } from "./tokens";

const Id = z.uuid().transform((s) => s.toLowerCase());
const At = z.iso.datetime({ offset: true });

const BagLineBody = z
  .object({
    sku_id: Id,
    qty: z.number().int().min(1).max(GUEST_MERGE_LIMITS.maxUnitsPerSku),
    saved_for_later: z.boolean().default(false),
    added_at: At,
  })
  .strict();
const SavedBody = z.object({ product_id: Id, sku_id: Id.optional(), intent: z.enum(GUEST_SAVED_INTENTS) }).strict();
const ViewedBody = z.object({ product_id: Id, viewed_at: At }).strict();

/** Unknown keys are a 400 (mass assignment, API3). A device price field is therefore impossible, not just ignored. */
export const GuestMergeBody = z
  .object({
    bag_lines: z.array(BagLineBody).default([]),
    saved: z.array(SavedBody).default([]),
    recently_viewed: z.array(ViewedBody).default([]),
  })
  .strict();

const CAPS = {
  bag_lines: GUEST_MERGE_LIMITS.maxBagLines,
  saved: GUEST_MERGE_LIMITS.maxSavedItems,
  recently_viewed: GUEST_MERGE_LIMITS.maxViewed,
} as const;

function tooLarge(): ProblemError {
  return new ProblemError(413, "payload-too-large", "The guest bag is over the allowed size", { code: "guest_merge_too_large" });
}

/** Array lengths are checked before any per-item parsing so an oversized body costs O(1). */
function assertWithinCaps(raw: unknown): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  for (const [key, cap] of Object.entries(CAPS)) {
    const v = (raw as Record<string, unknown>)[key];
    if (Array.isArray(v) && v.length > cap) throw tooLarge();
  }
}

@Controller("me")
export class GuestMergeController {
  constructor(
    @Inject(MERGE_GUEST) private readonly merge: MergeGuest,
    /** `flag.guest_browsing` (release flag, default blocked). Blocked: the route answers 404 before reading anything. */
    @Inject(GUEST_BROWSING_GATE) private readonly gate: PublicReadGate,
  ) {}

  @Post("guest-merge")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([
    { dimension: "user", limit: 5, windowSeconds: 60 },
    // A second window on the SAME dimension would share one counter in the guard; the session bucket is separate.
    { dimension: "session", limit: 20, windowSeconds: 86_400 },
  ])
  async run(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Body() raw: unknown) {
    await assertGuestBrowsingEnabled(this.gate);
    const userId = req.principal?.actor.id;
    if (userId === undefined) throw Problems.unauthenticated();
    assertWithinCaps(raw);
    const body = new ZodPipe(GuestMergeBody).transform(raw);
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const r = await this.merge.execute({
        userId,
        bag: body.bag_lines.map((l) => ({
          skuId: l.sku_id,
          qty: l.qty,
          savedForLater: l.saved_for_later,
          addedAtMs: Date.parse(l.added_at),
        })),
        saved: body.saved.map((s) => ({ productId: s.product_id, skuId: s.sku_id ?? null, intent: s.intent })),
        viewed: body.recently_viewed.map((v) => ({ productId: v.product_id, viewedAtMs: Date.parse(v.viewed_at) })),
      });
      return {
        cart: cartWire(r.cart),
        outcome: {
          lines: r.lines.map((l) => ({
            sku_id: l.skuId,
            result: l.result,
            reason: l.reason,
            qty: l.qty,
            previous_qty: l.previousQty,
          })),
          saved: {
            added: r.saved.added,
            duplicates: r.saved.duplicates,
            over_cap: r.saved.overCap,
            unavailable: r.saved.unavailable,
          },
          viewed: r.viewed,
        },
      };
    } catch (e) {
      if (e instanceof GuestCatalogUnavailableError) throw Problems.unavailable("catalog_unavailable");
      if (e instanceof MergeConflictError) {
        throw new ProblemError(409, "cart-conflict", "The bag changed on another device; retry", { code: "cart_conflict" });
      }
      throw e;
    }
  }
}
