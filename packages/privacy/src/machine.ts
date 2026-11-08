import { InvalidTransitionError } from "./errors.js";

export type RequestStatus = "RECEIVED" | "VERIFIED" | "BLOCKED" | "COOLING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "REJECTED";
export type MachineKind = "delete" | "export";

/** PrivacyRequest machine (data-model 7.6). Terminal states have no outgoing edges. */
export const TRANSITIONS: Readonly<Record<MachineKind, Readonly<Record<RequestStatus, readonly RequestStatus[]>>>> = {
  delete: {
    RECEIVED: ["VERIFIED", "REJECTED"],
    VERIFIED: ["BLOCKED", "COOLING", "IN_PROGRESS"],
    BLOCKED: [],
    COOLING: ["CANCELLED", "IN_PROGRESS"],
    IN_PROGRESS: ["COMPLETED"],
    COMPLETED: [],
    CANCELLED: [],
    REJECTED: [],
  },
  export: {
    RECEIVED: ["IN_PROGRESS", "COMPLETED", "REJECTED"],
    VERIFIED: [],
    BLOCKED: [],
    COOLING: [],
    IN_PROGRESS: ["COMPLETED"],
    COMPLETED: [],
    CANCELLED: [],
    REJECTED: [],
  },
};

export const canTransition = (kind: MachineKind, from: RequestStatus, to: RequestStatus): boolean => TRANSITIONS[kind][from].includes(to);

export const assertTransition = (kind: MachineKind, from: RequestStatus, to: RequestStatus): void => {
  if (!canTransition(kind, from, to)) throw new InvalidTransitionError(kind, from, to);
};
