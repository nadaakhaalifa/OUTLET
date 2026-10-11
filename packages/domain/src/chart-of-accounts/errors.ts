import { DomainError } from "../errors";

export class InvalidAccountError extends DomainError {}
export class TenderMismatchError extends DomainError {}
export class InsufficientCreditError extends DomainError {}
export class InvalidChartInputError extends DomainError {}
