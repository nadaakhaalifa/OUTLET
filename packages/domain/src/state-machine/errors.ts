import { DomainError } from "../errors";

export class MachineDefinitionError extends DomainError {}

export class UnknownStateError extends DomainError {
  constructor(
    readonly machine: string,
    readonly state: string,
  ) {
    super(`${machine}: unknown state "${state}"`);
  }
}

export class UnknownEventError extends DomainError {
  constructor(
    readonly machine: string,
    readonly event: string,
  ) {
    super(`${machine}: unknown event "${event}"`);
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly event: string,
    readonly allowedEvents: readonly string[],
  ) {
    super(
      `${machine}: event "${event}" is not allowed in state "${from}" (allowed: ${
        allowedEvents.length === 0 ? "none, terminal" : allowedEvents.join(", ")
      })`,
    );
  }
}

export class GuardRejectedError extends DomainError {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly event: string,
    readonly guard: string,
  ) {
    super(`${machine}: guard "${guard}" rejected event "${event}" in state "${from}"`);
  }
}
