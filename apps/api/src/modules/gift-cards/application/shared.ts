import { createHash, timingSafeEqual } from "node:crypto";
import {
  expiryFrom,
  expiryReached,
  formatCode,
  generateCode,
  last4,
  next,
  redemptionView,
  type DeliveryChannel,
} from "../domain/bridge";
import type {
  AgeGatePort,
  AuditPort,
  CardRecord,
  CardView,
  Clock,
  DeliveryPort,
  FieldCipherPort,
  GiftCardFlagsPort,
  GiftCardStore,
  IdPort,
  OutboxDraft,
  PaymentIntentPort,
  RandomPort,
  SecretPort,
  StoreCreditPort,
} from "../domain/ports";

export interface GiftCardDeps {
  readonly store: GiftCardStore;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly secret: SecretPort;
  readonly random: RandomPort;
  readonly cipher: FieldCipherPort;
  readonly storeCredit: StoreCreditPort;
  readonly audit: AuditPort;
  readonly flags: GiftCardFlagsPort;
  readonly age: AgeGatePort;
  readonly payments: PaymentIntentPort;
  readonly delivery: DeliveryPort;
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export function constantTimeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
export const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

export const contactAad = (cardId: string): string => `gift_card:${cardId}:recipient_contact`;
export const messageAad = (cardId: string): string => `gift_card:${cardId}:message`;

export function cardView(c: CardRecord): CardView {
  return {
    id: c.id,
    status: c.status,
    amount: c.amount,
    remaining: c.remaining,
    redemption: redemptionView(c.amount, c.remaining),
    last4: c.last4,
    expiresAtMs: c.expiresAtMs,
    design: c.design,
    scopeStoreId: c.scopeStoreId,
    createdAtMs: c.createdAtMs,
    potId: c.potId,
  };
}

export const cardEvent = (c: CardRecord, type: OutboxDraft["type"], extra: OutboxDraft["payload"] = {}): OutboxDraft => ({
  type,
  aggregateType: "gift_card",
  aggregateId: c.id,
  payload: { card_id: c.id, amount: Number(c.amount), currency: "EGP", ...extra },
});

/** Finds a card by code across all active key versions (rotation never strands issued cards). */
export async function findCardByCode(d: GiftCardDeps, canonical: string): Promise<CardRecord | null> {
  for (const v of await d.secret.activeVersions()) {
    const hit = await d.store.findByCodeHash(await d.secret.hmac(v, canonical));
    if (hit !== null) return hit;
  }
  return null;
}

export type IssueResult =
  | { readonly kind: "issued"; readonly card: CardRecord; readonly code: string; readonly delivery: "delivered" | "scheduled" | "failed" }
  | { readonly kind: "replayed"; readonly card: CardRecord }
  | { readonly kind: "conflict" }
  | { readonly kind: "not_found" };

/**
 * Mints the code, stores only HMAC + last4, moves the card to ISSUED and hands the code to the
 * delivery port. The code exists in memory for this call only and is returned to the caller once.
 */
export async function issueCard(
  d: GiftCardDeps,
  card: CardRecord,
  event: "PAYMENT_SUCCEEDED" | "CLOSE_POT",
): Promise<IssueResult> {
  const nowMs = d.clock.nowMs();
  const to = next(card.status, event, { nowMs, expiresAtMs: null, potFunded: event === "CLOSE_POT" });
  const code = generateCode((n) => d.random.bytes(n));
  const version = await d.secret.currentVersion();
  const hash = await d.secret.hmac(version, code);
  const expiresAtMs = expiryFrom(nowMs);
  const issuedEvent = cardEvent(card, "gift_card.issued", { scope_store_id: card.scopeStoreId, expires_at_ms: expiresAtMs });
  const r = await d.store.updateCard(
    card.id,
    card.version,
    { status: to, codeHash: hash, codeKeyVersion: version, last4: last4(code), expiresAtMs, issuedAtMs: nowMs },
    [issuedEvent],
  );
  if (r.kind === "not_found") return { kind: "not_found" };
  if (r.kind === "conflict") return { kind: "conflict" };
  await d.audit.record({
    action: "gift_card.issued",
    actorId: null,
    targetId: card.id,
    outcome: "n/a",
    deviceHash: null,
    ipHash: null,
    atMs: nowMs,
  });
  const issued = r.card;
  const contact = issued.recipientContactEnc === null ? null : dec(await d.cipher.decrypt(issued.recipientContactEnc, contactAad(issued.id)));
  const message = issued.messageEnc === null ? null : dec(await d.cipher.decrypt(issued.messageEnc, messageAad(issued.id)));
  const scheduled = issued.scheduledAtMs !== null && issued.scheduledAtMs > nowMs;
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
    try {
      ok = (
        await d.delivery.deliver({
          cardId: issued.id,
          channel: issued.recipientChannel as DeliveryChannel,
          contact,
          message,
          design: issued.design,
          code: formatCode(code),
          last4: last4(code),
          sendAtMs: scheduled ? issued.scheduledAtMs : null,
        })
      ).ok;
    } catch {
      ok = false;
    }
  }
  if (!ok) return { kind: "issued", card: issued, code: formatCode(code), delivery: "failed" };
  if (scheduled) return { kind: "issued", card: issued, code: formatCode(code), delivery: "scheduled" };
  const delivered = await markDelivered(d, issued);
  return { kind: "issued", card: delivered, code: formatCode(code), delivery: "delivered" };
}

export async function markDelivered(d: GiftCardDeps, card: CardRecord): Promise<CardRecord> {
  if (card.status !== "ISSUED") return card;
  const nowMs = d.clock.nowMs();
  const r = await d.store.updateCard(
    card.id,
    card.version,
    { status: next(card.status, "DELIVER", { nowMs, expiresAtMs: card.expiresAtMs }), deliveredAtMs: nowMs },
    [cardEvent(card, "gift_card.delivered", { channel: card.recipientChannel })],
  );
  return r.kind === "ok" ? r.card : card;
}

export { expiryReached };
