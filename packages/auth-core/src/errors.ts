export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidPhoneError extends AuthError {}
export class InvalidTokenShapeError extends AuthError {}
export class InvalidStateError extends AuthError {}
