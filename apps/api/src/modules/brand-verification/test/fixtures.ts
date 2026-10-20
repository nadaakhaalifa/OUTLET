import { createHash } from "node:crypto";
import type { Clock, IdGenerator } from "../domain/ports";
import type { ApplicationSnapshot } from "../domain/ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const START_MS = Date.parse("2026-10-11T09:00:00Z");

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Deterministic ids: uuidV7 counter and hex derived from a counter. */
export function fakeIds(): IdGenerator {
  let n = 0;
  return {
    uuidV7: () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`,
    hex: (bytes) => createHash("sha256").update(`hex-${++n}`).digest("hex").slice(0, bytes * 2),
  };
}

export const snapshot = (n: number, over: Partial<ApplicationSnapshot> = {}): ApplicationSnapshot => ({
  applicationId: U(100 + n),
  applicantId: U(10 + n),
  kind: "global",
  country: "FR",
  brandName: "Lumen Atelier",
  legalName: "Lumen Atelier SAS",
  websiteDomain: "lumen-atelier.com",
  trademark: { office: "EUIPO", number: "018123456" },
  submittedAtMs: START_MS,
  ...over,
});
