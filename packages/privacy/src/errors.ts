export class PrivacyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UserNotFoundError extends PrivacyError {
  constructor(userId: string) {
    super("user_not_found", `user ${userId} not found`);
  }
}

export class InvalidTransitionError extends PrivacyError {
  constructor(
    readonly kind: string,
    readonly from: string,
    readonly to: string,
  ) {
    super("invalid_transition", `${kind} request cannot move ${from} -> ${to}`);
  }
}

export class RequestNotFoundError extends PrivacyError {
  constructor(id: string) {
    super("request_not_found", `privacy request ${id} not found`);
  }
}

export class DuplicateOpenRequestError extends PrivacyError {
  constructor(kind: string) {
    super("duplicate_open_request", `an open ${kind} request already exists for this user`);
  }
}

export type DeletionBlockerKind = "open_order" | "open_return" | "open_dispute";
export interface DeletionBlocker {
  readonly kind: DeletionBlockerKind;
  readonly count: number;
}

/** Shown to the user: exactly why deletion is blocked (master prompt section 2). */
export class DeletionBlockedError extends PrivacyError {
  constructor(readonly blockers: readonly DeletionBlocker[]) {
    super("deletion_blocked", `deletion blocked by: ${blockers.map((b) => `${b.kind}(${String(b.count)})`).join(", ")}`);
  }
}
