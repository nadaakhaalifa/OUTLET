import {
  clusterSizeOf,
  detectSelfReferral,
  sharesPaymentFingerprint,
  type IdentityEntry,
} from "../referrals/fraud";

export type CreatorFraudReason = "self_purchase" | "same_device" | "shared_payment" | "shared_address" | "cluster";

export interface PartyIdentifiers {
  readonly userId: string;
  readonly deviceHashes: readonly string[];
  readonly paymentFingerprintHashes: readonly string[];
  readonly addressHashes: readonly string[];
}

/**
 * Reuses the referral fraud graph (device hashes, payment fingerprints) and adds the delivery
 * address. The caller voids silently and logs; the creator is never told which rule fired.
 * `otherBuyers` are the other buyers already attributed to this creator.
 */
export function decideCreatorFraud(input: {
  readonly creator: PartyIdentifiers;
  readonly buyer: PartyIdentifiers;
  readonly otherBuyers: readonly PartyIdentifiers[];
  readonly clusterThreshold: number;
}): CreatorFraudReason | null {
  const { creator, buyer } = input;
  const self = detectSelfReferral({
    referrerId: creator.userId,
    refereeId: buyer.userId,
    referrerDeviceHashes: creator.deviceHashes,
    refereeDeviceHashes: buyer.deviceHashes,
  });
  if (self === "self_referral") return "self_purchase";
  if (self === "same_device") return "same_device";
  for (const fp of buyer.paymentFingerprintHashes) {
    if (sharesPaymentFingerprint(fp, creator.paymentFingerprintHashes)) return "shared_payment";
  }
  const addr = new Set(creator.addressHashes);
  if (buyer.addressHashes.some((a) => addr.has(a))) return "shared_address";

  const ids = (p: PartyIdentifiers): string[] => [
    ...p.deviceHashes.map((d) => `dev:${d}`),
    ...p.paymentFingerprintHashes.map((f) => `fp:${f}`),
    ...p.addressHashes.map((a) => `addr:${a}`),
  ];
  const entries: IdentityEntry[] = [
    { userId: creator.userId, identifiers: ids(creator) },
    { userId: buyer.userId, identifiers: ids(buyer) },
    ...input.otherBuyers.map((b) => ({ userId: b.userId, identifiers: ids(b) })),
  ];
  return clusterSizeOf(buyer.userId, entries) > input.clusterThreshold ? "cluster" : null;
}
