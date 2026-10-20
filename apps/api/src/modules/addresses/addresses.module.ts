import { randomBytes } from "node:crypto";
import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { LocalKeyFieldCipher, type FieldCipher } from "../auth";
import { AddressesController } from "./addresses.controller";
import { AddressBookCheckoutPort } from "./checkout-port";
import { InMemoryAddressStore } from "./in-memory";
import type { AddressStore } from "./ports";
import { AddressService } from "./service";
import { ADDRESS_CIPHER, ADDRESS_SERVICE, ADDRESS_STORE } from "./tokens";

export interface AddressesModuleOptions {
  readonly store?: AddressStore;
  /** KMS envelope cipher. Unconfigured in production until the kms.envelope provider exists (503 on encrypted fields). */
  readonly cipher?: FieldCipher;
}

/** Process-wide runtime so composition can hand the SAME service to checkout. */
export function createAddressService(store: AddressStore, cipher: FieldCipher, clock: Clock, ids: IdGenerator): AddressService {
  return new AddressService(store, cipher, clock, ids, () => randomBytes(16).toString("base64url"));
}

export function checkoutAddressPort(service: AddressService): AddressBookCheckoutPort {
  return new AddressBookCheckoutPort(service);
}

@Module({})
export class AddressesModule {
  static forRoot(config: AppConfig, options: AddressesModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && (options.store === undefined || options.cipher === undefined)) throw new NoProductionAdaptersError();
    const store = options.store ?? new InMemoryAddressStore();
    const cipher = options.cipher ?? new LocalKeyFieldCipher(randomBytes(32));
    return {
      module: AddressesModule,
      controllers: [AddressesController],
      providers: [
        { provide: ADDRESS_STORE, useValue: store },
        { provide: ADDRESS_CIPHER, useValue: cipher },
        {
          provide: ADDRESS_SERVICE,
          inject: [CLOCK, ID_GENERATOR],
          useFactory: (clock: Clock, ids: IdGenerator): AddressService => createAddressService(store, cipher, clock, ids),
        },
      ],
      exports: [ADDRESS_SERVICE, ADDRESS_STORE],
    };
  }
}
