import { addresses } from "@outlet/domain";
import type { AddressPort } from "../checkout";

type AddressResolution = Awaited<ReturnType<AddressPort["resolve"]>>;
import { GIFT_TOKEN_PREFIX, type AddressService } from "./service";

/**
 * Checkout's AddressPort over the real address book. A saved address resolves to the first name,
 * the governorate and its coverage; a gift token resolves to coverage ONLY (no name, no phone), so
 * the buyer's session never touches the recipient's address. Not covered => `not_covered`.
 */
export class AddressBookCheckoutPort implements AddressPort {
  constructor(private readonly svc: AddressService) {}

  async resolve(userId: string, addressId: string): Promise<AddressResolution> {
    if (addressId.startsWith(GIFT_TOKEN_PREFIX)) {
      const d = await this.svc.giftDestination(addressId);
      if (d === null) return { kind: "not_found" };
      if (d.courierCoverage === "not_covered") return { kind: "not_covered" };
      return { kind: "ok", contact: { firstName: null, phoneRelay: null, governorateCode: d.governorateCode } };
    }
    if (!/^[0-9a-f-]{36}$/i.test(addressId)) return { kind: "not_found" };
    const a = await this.svc.get(userId, addressId.toLowerCase());
    if (a === null) return { kind: "not_found" };
    if (a.courierCoverage === "not_covered") return { kind: "not_covered" };
    return { kind: "ok", contact: { firstName: addresses.firstNameOf(a.recipientName), phoneRelay: null, governorateCode: a.governorateCode } };
  }
}
