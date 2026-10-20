import { DomainError } from "../errors";

/** Reconciliation input that is structurally invalid (duplicate line ids, bad config). */
export class InvalidReconciliationInputError extends DomainError {}
