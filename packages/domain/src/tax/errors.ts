import { DomainError } from "../errors";

export class InvalidTaxInputError extends DomainError {}
export class TaxDocumentInvalidError extends DomainError {}
export class DelegationRequiredError extends DomainError {}
export class ArabicTextRequiredError extends DomainError {}
