import type { CourierPort } from "../../fulfillment";
import type { OutboundCourierPort, OutboundResult, ParcelFacts, ParcelRecord } from "../../hub-consolidation";

/**
 * Outbound leg of a consolidated parcel through Aramex. The AWB is idempotent by `parcel.id`
 * (the courier reference). Rate cards are not modelled yet: cost is 0 (hub ledger entry then books
 * nothing for courier cost; register: Aramex rate card, VERIFY).
 */
export class AramexHubOutbound implements OutboundCourierPort {
  constructor(private readonly courier: CourierPort) {}
  async createOutbound(parcel: ParcelRecord, facts: ParcelFacts): Promise<OutboundResult> {
    const { awb } = await this.courier.createAwb({
      shipmentId: parcel.id,
      parcel: { weightG: facts.weightG, pieces: facts.pieces },
      cod: facts.cod,
      recipient: facts.recipient,
      pickup: facts.pickup,
    });
    return { awb, courierCode: this.courier.code, costPiastres: 0n };
  }
}
