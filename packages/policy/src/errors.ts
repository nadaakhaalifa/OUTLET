export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown by the strict parsers when untrusted input does not have the Actor or Resource shape. */
export class MalformedAuthzInputError extends PolicyError {}

/** Thrown when a rule set is internally inconsistent (for example a duplicate rule id). */
export class InvalidRuleSetError extends PolicyError {}
