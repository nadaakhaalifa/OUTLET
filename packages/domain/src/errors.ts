export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class CurrencyMismatchError extends DomainError {}
export class InvalidAmountError extends DomainError {}
export class UnbalancedEntryError extends DomainError {}
export class InvalidEntryError extends DomainError {}
