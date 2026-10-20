import { DomainError } from "../errors";

export class InvalidRefundInputError extends DomainError {}
export class RefundExceedsRefundableError extends DomainError {}
export class RefundRouteInvariantError extends DomainError {}
