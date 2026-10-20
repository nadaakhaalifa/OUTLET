import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import {
  FakeAttestation,
  FakeBotScore,
  FakeDropGate,
  FakeEntitlements,
  FakeSecrets,
  FakeSwitches,
  InMemoryAdmissionStore,
  InMemoryQueue,
} from "./adapters/in-memory";
import * as T from "./adapters/tokens";
import { WaitingRoomController } from "./adapters/waiting-room.controller";
import { jwtAdmissionCodec } from "./adapters/jwt";
import { AdmissionVerifier } from "./application/admission";
import { AdmitFromQueue } from "./application/admit";
import { JoinQueue } from "./application/join";
import { DEFAULT_WAITING_ROOM_CONFIG, type WaitingRoomConfig, type WaitingRoomDeps } from "./application/shared";
import { QueueStatus } from "./application/status";
import type {
  AdmissionStore,
  AttestationPort,
  BotScorePort,
  DropGatePort,
  EntitlementPort,
  QueuePort,
  SecretPort,
  SwitchPort,
} from "./domain/ports";

export interface WaitingRoomModuleOptions {
  readonly config?: WaitingRoomConfig;
  /** Redis sorted-set adapter in production. */
  readonly queue?: QueuePort;
  /** Postgres audit adapter (KyselyAdmissionStore). */
  readonly store?: AdmissionStore;
  readonly gate?: DropGatePort;
  readonly secrets?: SecretPort;
  readonly bot?: BotScorePort;
  readonly attest?: AttestationPort;
  readonly entitlements?: EntitlementPort;
  readonly switches?: SwitchPort;
}

/** Thrown outside test mode when a port is missing: the room must never run on stub security. */
export class MissingWaitingRoomPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`WaitingRoomModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingWaitingRoomPortsError";
  }
}

@Module({})
export class WaitingRoomModule {
  static forRoot(config: AppConfig, o: WaitingRoomModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && (o.store === undefined || o.queue === undefined)) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.queue === undefined) missing.push("queue (Redis)");
      if (o.store === undefined) missing.push("store (Postgres)");
      if (o.gate === undefined) missing.push("gate (drops module)");
      if (o.secrets === undefined) missing.push("secrets (secret manager)");
      if (o.bot === undefined) missing.push("bot (fraud scoring)");
      if (o.attest === undefined) missing.push("attest (App Attest / Play Integrity)");
      if (o.entitlements === undefined) missing.push("entitlements (Plus)");
      if (o.switches === undefined) missing.push("switches (feature flags)");
      if (missing.length > 0) throw new MissingWaitingRoomPortsError(missing);
    }
    const queue = o.queue ?? new InMemoryQueue();
    const store = o.store ?? new InMemoryAdmissionStore();
    const gate = o.gate ?? new FakeDropGate();
    const secrets = o.secrets ?? new FakeSecrets();
    const bot = o.bot ?? new FakeBotScore();
    const attest = o.attest ?? new FakeAttestation();
    const entitlements = o.entitlements ?? new FakeEntitlements();
    const switches = o.switches ?? new FakeSwitches();
    const cfg = o.config ?? DEFAULT_WAITING_ROOM_CONFIG;

    const RUNTIME = Symbol("waitingRoom.Runtime");
    const runtime = (clock: Clock, ids: IdGenerator) => {
      const d: WaitingRoomDeps = { queue, gate, store, secrets, codec: jwtAdmissionCodec, bot, attest, entitlements, switches, clock, ids, cfg };
      return {
        join: new JoinQueue(d),
        status: new QueueStatus(d),
        admit: new AdmitFromQueue(d),
        verifier: new AdmissionVerifier(secrets, store, clock, jwtAdmissionCodec),
      };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });
    return {
      module: WaitingRoomModule,
      controllers: [WaitingRoomController],
      providers: [
        { provide: T.WR_QUEUE, useValue: queue },
        { provide: T.WR_STORE, useValue: store },
        { provide: T.WR_GATE, useValue: gate },
        { provide: T.WR_SECRETS, useValue: secrets },
        { provide: T.WR_BOT, useValue: bot },
        { provide: T.WR_ATTEST, useValue: attest },
        { provide: T.WR_ENTITLEMENTS, useValue: entitlements },
        { provide: T.WR_SWITCHES, useValue: switches },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: Clock, i: IdGenerator) => runtime(c, i) },
        from(T.JOIN_QUEUE, (r) => r.join),
        from(T.QUEUE_STATUS, (r) => r.status),
        from(T.ADMIT_FROM_QUEUE, (r) => r.admit),
        from(T.ADMISSION_VERIFIER, (r) => r.verifier),
      ],
      exports: [T.ADMIT_FROM_QUEUE, T.ADMISSION_VERIFIER],
    };
  }
}
