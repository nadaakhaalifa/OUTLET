import { ApiError, dataOf, type schemas } from "../../services/api-client";
import { guard, money, msOrNull, toPortError, unsupported, type AdapterContext } from "../../services/wire";
import type {
  GiftCardsPort, GiftCardStatus, GiftDesign, GiftSnapshot, OwnedGiftCard, PurchaseOutcome, PurchaseRequest, RedeemOutcome,
} from "./model";

const DESIGN_FROM: Readonly<Record<schemas.GiftCard["design"], GiftDesign>> = {
  birthday: "birthday", eid: "eid", ramadan: "ramadan", wedding: "wedding", new_baby: "newBaby", graduation: "graduation", thank_you: "thankYou",
};
/** Default gift-card expiry shown to shoppers (master prompt 15.1: 3 years, VERIFY). Not on the wire (gap). */
const EXPIRY_MONTHS = 36;

function status(c: schemas.GiftCard): GiftCardStatus {
  const s = c.status.toUpperCase();
  if (s === "REDEEMED") return money(c.remaining) > 0n ? "REDEEMED_PARTIAL" : "REDEEMED_FULL";
  const known: readonly GiftCardStatus[] = ["PENDING_PAYMENT", "ISSUED", "DELIVERED", "REDEEMED_PARTIAL", "REDEEMED_FULL", "EXPIRED", "VOIDED"];
  return known.find((k) => k === s) ?? "ISSUED";
}

/** /v1/gift-cards. Purchase, pots need inputs the ports do not carry (payment method, design/channel): declared unsupported. */
export class ApiGiftCardsPort implements GiftCardsPort {
  constructor(private readonly ctx: AdapterContext) {}

  load(): Promise<GiftSnapshot> {
    return guard(async () => {
      const [cards, me] = await Promise.all([this.ctx.client.listMyGiftCards().then(dataOf), this.ctx.client.getMe().then(dataOf)]);
      return {
        capabilities: { sales: true, redemption: true },
        purchaserAdult: me.age_band === "21_plus",
        expiryMonths: EXPIRY_MONTHS,
        cards: cards.items.map((c): OwnedGiftCard => ({
          id: c.id, last4: c.last4, amount: money(c.amount), design: DESIGN_FROM[c.design], status: status(c), expiresAt: msOrNull(c.expires_at), scheduledDate: null,
        })),
        // There is no "list my pots" operation (gap).
        pots: [],
      };
    });
  }

  async purchase(req: PurchaseRequest, _idempotencyKey: string): Promise<PurchaseOutcome> {
    throw unsupported(`gift card purchase needs payment_method (PurchaseRequest has none): ${req.design}`);
  }

  async redeem(normalisedCode: string, idempotencyKey: string): Promise<RedeemOutcome> {
    try {
      const r = dataOf(await this.ctx.client.redeemGiftCard({ body: { code: normalisedCode } }, { idempotencyKey }));
      return { kind: "redeemed", amount: money(r.redeemed) };
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 429) return { kind: "rateLimited", retryAfterSeconds: e.retryAfterSeconds };
        if (e.status === 503) return { kind: "disabled" };
        if (e.status >= 400 && e.status < 500) return { kind: "invalid", remainingAttempts: null };
      }
      throw toPortError(e);
    }
  }

  voidCard(cardId: string, idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.voidGiftCard({ path: { id: cardId } }, { idempotencyKey }));
    });
  }

  async createPot(_target: bigint, _closesOn: string, _title: string, _key: string): Promise<void> {
    throw unsupported("gift pot create needs design, channel and organiser nickname (createPot has only target, date, title)");
  }

  async contribute(_potId: string, _amount: bigint, _key: string): Promise<void> {
    throw unsupported("gift pot contribute needs share_token and payment_method");
  }
}
