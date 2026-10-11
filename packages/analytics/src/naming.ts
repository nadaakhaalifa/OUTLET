import { InvalidEventNameError, InvalidPropertyNameError } from "./errors";

const SNAKE = "[a-z][a-z0-9]*(?:_[a-z0-9]+)*";

/** Analytics events: snake_case, 3..64 chars, no dots (dots are reserved for domain events). */
const ANALYTICS_EVENT_RE = new RegExp(`^${SNAKE}$`);
/** Domain (outbox) events: `aggregate.action`, exactly one dot, both sides snake_case. */
const DOMAIN_EVENT_RE = new RegExp(`^${SNAKE}\\.${SNAKE}$`);
/** Property keys: snake_case, 1..40 chars. */
const PROPERTY_RE = new RegExp(`^${SNAKE}$`);

export const ANALYTICS_EVENT_NAME_MAX = 64;
export const DOMAIN_EVENT_NAME_MAX = 80;
export const PROPERTY_NAME_MAX = 40;

/** Tokens that must never appear in an event or property name. Shared with the PII policy. */
export const FORBIDDEN_NAME_TOKENS: ReadonlySet<string> = new Set([
  "email", "phone", "msisdn", "password", "passcode", "otp", "token", "secret", "ssn", "passport",
  "iban", "cvv", "cvc", "pan", "dob", "birthday", "birthdate", "birth", "firstname", "lastname",
  "fullname", "name", "nickname", "address", "street", "building", "apartment", "landmark",
  "lat", "lng", "lon", "latitude", "longitude", "gps", "ip", "photo", "selfie", "height", "weight",
  "bust", "waist", "hip", "chest", "inseam", "measurement", "measurements", "query", "text",
  "message", "comment", "note", "body",
]);

function hasForbiddenToken(name: string): string | undefined {
  return name.split("_").find((t) => FORBIDDEN_NAME_TOKENS.has(t));
}

export function isValidAnalyticsEventName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length >= 3 &&
    name.length <= ANALYTICS_EVENT_NAME_MAX &&
    ANALYTICS_EVENT_RE.test(name) &&
    hasForbiddenToken(name) === undefined
  );
}

export function isValidDomainEventName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length >= 3 &&
    name.length <= DOMAIN_EVENT_NAME_MAX &&
    DOMAIN_EVENT_RE.test(name) &&
    hasForbiddenToken(name.replace(".", "_")) === undefined
  );
}

export function isValidPropertyName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= PROPERTY_NAME_MAX &&
    PROPERTY_RE.test(name) &&
    hasForbiddenToken(name) === undefined
  );
}

export function assertAnalyticsEventName(name: string): string {
  if (!isValidAnalyticsEventName(name)) {
    throw new InvalidEventNameError(
      `invalid analytics event name "${name}": expected snake_case, 3-${ANALYTICS_EVENT_NAME_MAX} chars, no PII-like token`,
    );
  }
  return name;
}

export function assertDomainEventName(name: string): string {
  if (!isValidDomainEventName(name)) {
    throw new InvalidEventNameError(
      `invalid domain event name "${name}": expected aggregate.action in snake_case, max ${DOMAIN_EVENT_NAME_MAX} chars`,
    );
  }
  return name;
}

export function assertPropertyName(name: string): string {
  if (!isValidPropertyName(name)) {
    throw new InvalidPropertyNameError(
      `invalid property name "${name}": expected snake_case, 1-${PROPERTY_NAME_MAX} chars, no PII-like token`,
    );
  }
  return name;
}
