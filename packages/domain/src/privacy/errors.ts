import { DomainError } from "../errors";

export class PrivacyDomainError extends DomainError {}

/** A deletion cannot start while orders, returns or disputes are open (spec section 2 Rules). */
export class DeletionBlockedError extends PrivacyDomainError {
  constructor(readonly blockers: readonly { readonly kind: string; readonly count: number }[]) {
    super(`deletion blocked by: ${blockers.map((b) => `${b.kind}=${b.count}`).join(", ")}`);
  }
}

export class ForfeitureNotAcknowledgedError extends PrivacyDomainError {
  constructor() {
    super("store-credit forfeiture must be acknowledged before deletion");
  }
}

export class NotYetExpirableError extends PrivacyDomainError {
  constructor(what: string) {
    super(`${what} is not past its expiry`);
  }
}

export class InvalidPrivacyInputError extends PrivacyDomainError {}
