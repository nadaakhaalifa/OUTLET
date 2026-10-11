import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { AramexCourier } from "./adapters/aramex-courier";
import { FakeAramexTransport, StaticAramexCredentials } from "./adapters/fake-aramex";
import { AramexHubOutbound } from "./adapters/hub-outbound";
import type { AramexCredentialsPort, AramexTransport } from "./domain/ports";

export const ARAMEX_COURIER = Symbol("aramex.CourierPort");
export const ARAMEX_HUB_OUTBOUND = Symbol("aramex.HubOutbound");

export interface CourierAramexOptions {
  /** Egress-proxied HTTP client. Required outside test mode. */
  readonly transport?: AramexTransport;
  /** Secret-manager backed. Required outside test mode. */
  readonly credentials?: AramexCredentialsPort;
}

export class MissingAramexPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`CourierAramexModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingAramexPortsError";
  }
}

@Module({})
export class CourierAramexModule {
  static forRoot(config: AppConfig, o: CourierAramexOptions = {}): DynamicModule {
    if (config.adapters !== "in-memory-dev" || config.env !== "test") {
      const missing: string[] = [];
      if (o.transport === undefined) missing.push("transport (Aramex HTTP via egress proxy)");
      if (o.credentials === undefined) missing.push("credentials (secret manager)");
      if (missing.length > 0) throw new MissingAramexPortsError(missing);
    }
    const courier = new AramexCourier(o.transport ?? new FakeAramexTransport(), o.credentials ?? new StaticAramexCredentials());
    return {
      module: CourierAramexModule,
      providers: [
        { provide: ARAMEX_COURIER, useValue: courier },
        { provide: ARAMEX_HUB_OUTBOUND, useValue: new AramexHubOutbound(courier) },
      ],
      exports: [ARAMEX_COURIER, ARAMEX_HUB_OUTBOUND],
    };
  }
}
