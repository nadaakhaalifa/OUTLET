import { DomainError } from "../errors";

export class InvalidCheckoutError extends DomainError {}
export class InvalidSagaTransitionError extends DomainError {}
