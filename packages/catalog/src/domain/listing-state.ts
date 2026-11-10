import { CatalogError } from "./errors.js";

/** docs/data-model.md 7.9: DRAFT -> IN_REVIEW -> PUBLISHED <-> PAUSED, PUBLISHED <-> SOLD_OUT, * -> ARCHIVED, * -> BLOCKED. */
export const LISTING_STATUSES = ["DRAFT", "IN_REVIEW", "PUBLISHED", "PAUSED", "SOLD_OUT", "ARCHIVED", "BLOCKED"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

const TRANSITIONS: Readonly<Record<ListingStatus, readonly ListingStatus[]>> = {
  DRAFT: ["IN_REVIEW", "ARCHIVED", "BLOCKED"],
  IN_REVIEW: ["PUBLISHED", "DRAFT", "ARCHIVED", "BLOCKED"],
  PUBLISHED: ["PAUSED", "SOLD_OUT", "ARCHIVED", "BLOCKED"],
  PAUSED: ["PUBLISHED", "ARCHIVED", "BLOCKED"],
  SOLD_OUT: ["PUBLISHED", "ARCHIVED", "BLOCKED"],
  ARCHIVED: [],
  BLOCKED: ["IN_REVIEW", "ARCHIVED"],
};

/** Statuses a shopper can see (public read model). */
export const PUBLIC_STATUSES: readonly ListingStatus[] = ["PUBLISHED", "SOLD_OUT", "PAUSED"];

export class InvalidTransitionError extends CatalogError {
  constructor(
    readonly from: ListingStatus,
    readonly to: ListingStatus,
  ) {
    super("invalid_transition", `listing cannot go from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export const isListingStatus = (s: string): s is ListingStatus => (LISTING_STATUSES as readonly string[]).includes(s);

export const canTransition = (from: ListingStatus, to: ListingStatus): boolean => TRANSITIONS[from].includes(to);

export const allowedTransitions = (from: ListingStatus): readonly ListingStatus[] => TRANSITIONS[from];

/** Returns `to` or throws InvalidTransitionError. */
export const transition = (from: ListingStatus, to: ListingStatus): ListingStatus => {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
};

/** Applies a path of transitions (for example DRAFT -> IN_REVIEW -> PUBLISHED), validating every hop. */
export const transitionPath = (from: ListingStatus, ...steps: readonly ListingStatus[]): ListingStatus => steps.reduce<ListingStatus>((cur, next) => transition(cur, next), from);
