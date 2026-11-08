import { InventoryError } from "./errors.js";

export const UNIT_STATES = ["available", "reserved", "claimed"] as const;
export type UnitState = (typeof UNIT_STATES)[number];
export type UnitEvent = "reserve" | "claim" | "release";

const UNIT_TABLE: Readonly<Record<UnitState, Readonly<Partial<Record<UnitEvent, UnitState>>>>> = {
  available: { reserve: "reserved" },
  reserved: { claim: "claimed", release: "available" },
  claimed: {},
};

export const RESERVATION_STATES = ["ACTIVE", "CLAIMED", "RELEASED", "EXPIRED"] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];
export type ReservationEvent = "claim" | "release" | "expire" | "late_claim";

/**
 * ACTIVE -> CLAIMED | RELEASED | EXPIRED (ERD machine). EXPIRED -> CLAIMED via late_claim is the ADR-0005 late-payment
 * path (auto-claim when stock is still available); the service refunds when it is not. CLAIMED and RELEASED are terminal.
 */
const RESERVATION_TABLE: Readonly<Record<ReservationState, Readonly<Partial<Record<ReservationEvent, ReservationState>>>>> = {
  ACTIVE: { claim: "CLAIMED", release: "RELEASED", expire: "EXPIRED" },
  EXPIRED: { late_claim: "CLAIMED" },
  CLAIMED: {},
  RELEASED: {},
};

const fail = (machine: string, from: string, event: string): never => {
  throw new InventoryError("invalid_transition", `${machine}: cannot ${event} from ${from}`);
};

export const unitTransition = (from: UnitState, event: UnitEvent): UnitState => UNIT_TABLE[from][event] ?? fail("unit", from, event);
export const reservationTransition = (from: ReservationState, event: ReservationEvent): ReservationState =>
  RESERVATION_TABLE[from][event] ?? fail("reservation", from, event);
export const canUnitTransition = (from: UnitState, event: UnitEvent): boolean => UNIT_TABLE[from][event] !== undefined;
export const canReservationTransition = (from: ReservationState, event: ReservationEvent): boolean => RESERVATION_TABLE[from][event] !== undefined;
