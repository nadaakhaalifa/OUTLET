import type { DropState } from "../state-machine/machines/drop";

export const DROP_TYPES = ["public", "members_only", "flash_hour", "mystery_box", "price_ladder", "last_chance"] as const;
export type DropType = (typeof DROP_TYPES)[number];

export const HOUR_MS = 3_600_000;
export const EARLY_ACCESS_MS = 24 * HOUR_MS;

export interface DropItem {
  readonly skuId: string;
  /** Units the seller put into the drop (never lowered after SCHEDULED). */
  readonly stockCap: number;
  /** Integer piastres. For price ladders this is the opening price. */
  readonly pricePiastres: bigint;
}

export interface LadderStep {
  readonly atMs: number;
  readonly pricePiastres: bigint;
}

export interface MysteryTerms {
  /** Disclosed value range and guaranteed minimum (spec 16, lottery rules VR-09). */
  readonly minValuePiastres: bigint;
  readonly maxValuePiastres: bigint;
  readonly guaranteedMinPiastres: bigint;
}

export interface DropLimits {
  readonly perUser: number;
  readonly perDevice: number;
}

export interface Drop {
  readonly id: string;
  readonly storeId: string;
  readonly type: DropType;
  readonly state: DropState;
  readonly title: string;
  readonly startsAtMs: number;
  /** Members-only early access opens here; null for every other type. */
  readonly earlyAccessAtMs: number | null;
  readonly endsAtMs: number;
  readonly items: readonly DropItem[];
  readonly limits: DropLimits;
  readonly ladder: readonly LadderStep[];
  readonly mystery: MysteryTerms | null;
  /** Admission rate for the waiting room. */
  readonly admitPerSec: number;
  /** T&S or ops pause. Not a lifecycle state: reversible, orders already placed are honoured. */
  readonly paused: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly version: number;
}

export interface FieldError {
  readonly field: string;
  readonly code: string;
}
