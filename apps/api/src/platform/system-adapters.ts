import { randomBytes } from "node:crypto";
import type { Csprng } from "@outlet/auth-core";
import { formatUuidV7 } from "@outlet/validation";
import type { Clock, IdGenerator } from "./ports";

export const systemClock: Clock = { nowMs: () => Date.now() };

export const nodeCsprng: Csprng = {
  randomBytes: (length) => new Uint8Array(randomBytes(length)),
};

export function createIdGenerator(clock: Clock, rng: Csprng): IdGenerator {
  return {
    uuidV7: () => formatUuidV7(clock.nowMs(), rng.randomBytes(10)),
    hex: (bytes) => Array.from(rng.randomBytes(bytes), (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}
