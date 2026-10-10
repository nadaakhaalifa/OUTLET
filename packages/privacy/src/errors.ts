export class PrivacyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidInputError extends PrivacyError {}
export class ConsentError extends PrivacyError {}
export class AgePolicyError extends PrivacyError {}
export class DsarTransitionError extends PrivacyError {}
export class DeletionError extends PrivacyError {}
export class RetentionError extends PrivacyError {}
