import type { CourierPort, CreatedShipment } from "@outlet/shipping";
import { Problems } from "../../platform/problem.js";
import type { BuyerDeliveryPort } from "./ports.js";

/** No courier contract exists (owner decision V33/V43): creating a shipment fails closed with 503, nothing is guessed. */
export class UnconfiguredCourier implements CourierPort {
  createShipment(): Promise<CreatedShipment> {
    return Promise.reject(Problems.unavailable("courier-unconfigured"));
  }
  cancelShipment(): Promise<void> {
    return Promise.reject(Problems.unavailable("courier-unconfigured"));
  }
  normalise(): undefined {
    return undefined;
  }
}

/** The addresses table is not built: no delivery data exists to show. */
export class UnconfiguredBuyerDelivery implements BuyerDeliveryPort {
  forSellerOrder(): Promise<null> {
    return Promise.resolve(null);
  }
}
