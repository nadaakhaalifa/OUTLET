import { DomainError } from "../errors";

/** Input that cannot describe a payout (negative amounts, bad cycle config, unknown ids). */
export class InvalidPayoutInputError extends DomainError {}
/** An IBAN that fails the structural check. Never carries the IBAN itself. */
export class InvalidIbanError extends DomainError {}
