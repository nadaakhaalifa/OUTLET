export class OutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidOutboxRecordError extends OutboxError {}
export class InvalidConfigError extends OutboxError {}
export class DuplicateOutboxEventError extends OutboxError {}
export class UnknownOutboxEventError extends OutboxError {}
export class InvalidReplayError extends OutboxError {}
export class InvalidInboxMessageError extends OutboxError {}
export class InvalidSagaDefinitionError extends OutboxError {}
export class InvalidSagaTransitionError extends OutboxError {}

/**
 * Throw from a Publisher when retrying can never succeed (for example the
 * broker rejected the message as malformed). The relay dead-letters at once
 * instead of burning the retry budget.
 */
export class PermanentPublishError extends OutboxError {}
