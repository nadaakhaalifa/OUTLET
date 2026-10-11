import type { PaymentMethodSwitchPort } from "../domain/ports";
import { PAYMENT_METHOD_META, type KillSwitchFamily, type PaymentMethodId } from "../domain/seam";

/** Structural subset of `FlagClient` (packages/feature-flags): `isPaymentMethodEnabled` fails closed. */
export interface PaymentKillSwitchFlags {
  isPaymentMethodEnabled(method: KillSwitchFamily): Promise<boolean>;
}

/**
 * Kill switch per payment method backed by `packages/feature-flags`. The client fails closed (an
 * unknown, erroring or non-boolean flag is OFF), so an outage of the flag provider hides payment
 * methods rather than silently enabling them. `meeza` shares the card switch (`kill.payment.card`).
 */
export class FlagPaymentMethodSwitch implements PaymentMethodSwitchPort {
  constructor(private readonly flags: PaymentKillSwitchFlags) {}

  isEnabled(method: PaymentMethodId): Promise<boolean> {
    const family: KillSwitchFamily = PAYMENT_METHOD_META[method].killSwitch;
    return this.flags.isPaymentMethodEnabled(family);
  }
}

/**
 * Test and in-memory dev switch. Defaults to all methods ON (explicitly not the production default).
 * Switches are per family, exactly like `kill.payment.<family>`: disabling `card` also hides `meeza`.
 */
export class StaticPaymentMethodSwitch implements PaymentMethodSwitchPort {
  private readonly off = new Set<KillSwitchFamily>();
  disable(...f: KillSwitchFamily[]): void {
    for (const x of f) this.off.add(x);
  }
  enable(...f: KillSwitchFamily[]): void {
    for (const x of f) this.off.delete(x);
  }
  async isEnabled(method: PaymentMethodId): Promise<boolean> {
    return !this.off.has(PAYMENT_METHOD_META[method].killSwitch);
  }
}
