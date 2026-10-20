import { DomainError } from "../errors";

/** The same idempotency key arrived with a different payload. Never retried with the new payload. */
export class PostingConflictError extends DomainError {
  constructor(
    readonly idempotencyKey: string,
    readonly existingEntryId: string,
  ) {
    super(`idempotency key "${idempotencyKey}" was already used for a different entry (${existingEntryId})`);
  }
}

export class GiftCardSalesDisabledError extends DomainError {}
export class InvalidReversalError extends DomainError {}
export class InvalidPostingCommandError extends DomainError {}
export class RefundExceedsOriginalError extends DomainError {}
