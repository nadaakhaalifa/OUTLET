import { createCipheriv, randomBytes } from "node:crypto";
import type {
  AddressPort, BillingPort, CreateIntentResult, PaymentProviderPort, PriceSnapshotPort, RawBodyCipher, RefundPort, ShippingQuotePort, SubMerchantPort, WebhookVerification,
} from "@outlet/checkout";

/**
 * Production adapters while no provider contract is signed (owner decision D5 = Paymob, but no Paymob call is made until then;
 * ADR-0029). Each one fails closed: nothing is charged, nothing is verified, nothing is guessed.
 */
export class UnconfiguredPaymentProvider implements PaymentProviderPort {
  readonly provider = "paymob" as const;
  supports(): boolean {
    return false;
  }
  createIntent(): Promise<CreateIntentResult> {
    return Promise.resolve({ ok: false, retryable: false, code: "provider_unconfigured" });
  }
  voidIntent(): Promise<{ readonly outcome: "voided" | "already_captured" | "not_found" }> {
    return Promise.resolve({ outcome: "not_found" });
  }
  /** No secret exists to verify against, so every webhook is a bad signature. */
  verifyWebhook(): WebhookVerification {
    return { ok: false, reason: "bad_signature" };
  }
}

export class UnconfiguredShipping implements ShippingQuotePort {
  quote(): ReturnType<ShippingQuotePort["quote"]> {
    return Promise.resolve({ unavailable: true, reason: "shipping_unconfigured" });
  }
}

export class UnconfiguredAddress implements AddressPort {
  resolve(): ReturnType<AddressPort["resolve"]> {
    return Promise.resolve(null);
  }
}

/** Prices carry no reference claim: the honest answer when the Price Integrity snapshot is not wired. */
export class PlainPrices implements PriceSnapshotPort {
  snapshotForOrderLine(): ReturnType<PriceSnapshotPort["snapshotForOrderLine"]> {
    return Promise.resolve({ vrp: null, evidenceIds: [], claimType: "plain" });
  }
}

export class UnconfiguredSubMerchants implements SubMerchantPort {
  refFor(): Promise<null> {
    return Promise.resolve(null);
  }
}

export class UnconfiguredBilling implements BillingPort {
  billingFor(): Promise<never> {
    return Promise.reject(new Error("billing data source is not configured"));
  }
}

export class UnconfiguredRefunds implements RefundPort {
  requestRefund(): ReturnType<RefundPort["requestRefund"]> {
    return Promise.resolve({ accepted: false });
  }
}

/** AES-256-GCM, iv(12) || tag(16) || ciphertext, aad-bound, for the raw webhook body (P2). The 32-byte key comes from the secrets manager. */
export class AesRawBodyCipher implements RawBodyCipher {
  constructor(private readonly key: Uint8Array) {
    if (key.length !== 32) throw new RangeError("AES-256 key must be 32 bytes");
  }
  encrypt(plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return Promise.resolve(Buffer.concat([iv, c.getAuthTag(), ct]));
  }
}
