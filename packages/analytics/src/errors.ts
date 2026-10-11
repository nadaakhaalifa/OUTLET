/** Base class for typed analytics errors. Thrown only by constructors and assertions, never by the tracker. */
export class AnalyticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidEventNameError extends AnalyticsError {}
export class InvalidPropertyNameError extends AnalyticsError {}
export class PiiPolicyViolationError extends AnalyticsError {}
export class InvalidPseudonymousIdError extends AnalyticsError {}
