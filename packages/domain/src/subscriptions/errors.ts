import { DomainError } from "../errors";

export class SubscriptionRuleError extends DomainError {}

export { InvalidTransitionError as InvalidSubscriptionTransition } from "../state-machine/errors";
