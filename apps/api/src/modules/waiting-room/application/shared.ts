import { createHash } from "node:crypto";
import { DEFAULT_BOT_CONFIG, type BotConfig } from "../domain/bridge";
import type {
  AdmissionStore,
  AttestationPort,
  BotScorePort,
  Clock,
  DropGatePort,
  EntitlementPort,
  IdPort,
  QueuePort,
  AdmissionCodec,
  SecretPort,
  SwitchPort,
} from "../domain/ports";

export interface WaitingRoomConfig {
  /** App Attest / Play Integrity required to join (spec 16). Flag, default on. */
  readonly requireAttest: boolean;
  /** Queue opens this long before the first admission so the room is warm. */
  readonly preQueueMs: number;
  readonly bot: BotConfig;
  /** Admission burst cap in seconds of rate. */
  readonly maxBurstSeconds: number;
}

export const DEFAULT_WAITING_ROOM_CONFIG: WaitingRoomConfig = {
  requireAttest: true,
  preQueueMs: 10 * 60_000,
  bot: DEFAULT_BOT_CONFIG,
  maxBurstSeconds: 2,
};

export interface WaitingRoomDeps {
  readonly queue: QueuePort;
  readonly gate: DropGatePort;
  readonly store: AdmissionStore;
  readonly secrets: SecretPort;
  readonly codec: AdmissionCodec;
  readonly bot: BotScorePort;
  readonly attest: AttestationPort;
  readonly entitlements: EntitlementPort;
  readonly switches: SwitchPort;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly cfg: WaitingRoomConfig;
}

/** Device ids are P2: only their SHA-256 is ever stored or put in a token. */
export const deviceHash = (deviceId: string): string => createHash("sha256").update(deviceId, "utf8").digest("hex");
