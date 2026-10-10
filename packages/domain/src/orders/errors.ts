import { DomainError } from "../errors";

/** Accept attempted at or after `accept_by`: the SLA sweep owns the order now (spec 19). */
export class AcceptWindowElapsedError extends DomainError {}
/** The order is past the point where the shopper may cancel (SHIPPED and later). */
export class NotCancellableError extends DomainError {}
/** Order intake data that cannot be a valid order (no lines, totals that do not add up). */
export class InvalidOrderIntakeError extends DomainError {}
