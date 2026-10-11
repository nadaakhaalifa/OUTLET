/** Raw HTTP boundary to Aramex. Real implementation lives behind the egress proxy (not in this module). */
export interface AramexResponse {
  readonly status: number;
  readonly body: unknown;
}
export interface AramexTransport {
  /** Throws on network failure or timeout. `path` is relative to the Aramex base URL. */
  post(path: string, body: unknown): Promise<AramexResponse>;
}

/** Account identifiers are secrets: resolved at call time from the secret manager, never logged. */
export interface AramexCredentials {
  readonly accountNumber: string;
  readonly accountPin: string;
  readonly accountEntity: string;
  readonly accountCountryCode: string;
  readonly userName: string;
  readonly password: string;
  readonly version: string;
}
export interface AramexCredentialsPort {
  get(): Promise<AramexCredentials>;
}
