import { z } from "zod";
import { passkeyOptions, sessionTokens, type PasskeyOptions } from "../api/schemas";
import { NetworkError, type Transport } from "../api/transport";
import { err, ok, type Result } from "../lib/result";
import { toState, type CredentialPort, type SessionFailure, type SessionPort, type SessionState, type SessionStore } from "./port";

export interface ApiSessionDeps {
  readonly transport: Transport;
  readonly store: SessionStore;
  readonly credentials: CredentialPort;
  readonly installId: () => string;
  readonly newIdempotencyKey: () => string;
}

/**
 * SessionPort over /v1/auth/passkey/assert/options, /v1/auth/passkey/assert, /v1/auth/refresh, /v1/auth/logout.
 * TOTP: the OpenAPI document has no seller TOTP endpoint yet, so verifyTotp fails closed with "totp_unavailable".
 * Seller device platform: the API's DeviceInfo enum is ios|android only (web is not in the contract; see spec gaps).
 */
export class ApiSession implements SessionPort {
  constructor(private readonly d: ApiSessionDeps) {}

  current(): Promise<SessionState | null> {
    return this.d.store.read();
  }

  /** Step 1 (server): fetch the WebAuthn challenge. The browser then signs it with navigator.credentials. */
  async beginPasskey(): Promise<Result<PasskeyOptions, SessionFailure>> {
    try {
      const res = await this.d.transport.send({ method: "POST", path: "/v1/auth/passkey/assert/options", body: {} });
      const opts = passkeyOptions.safeParse(res.json);
      return res.status === 200 && opts.success ? ok(opts.data) : err("rejected");
    } catch (e) {
      return err(e instanceof NetworkError ? "network" : "rejected");
    }
  }

  /** Step 2 (server): exchange the browser's assertion for tokens and store them. */
  async completePasskey(challengeId: string, credential: unknown): Promise<Result<SessionState, SessionFailure>> {
    try {
      const res = await this.d.transport.send({
        method: "POST",
        path: "/v1/auth/passkey/assert",
        headers: { "idempotency-key": this.d.newIdempotencyKey() },
        body: { challenge_id: challengeId, credential, device: { platform: "ios", install_id: this.d.installId() } },
      });
      const tokens = sessionTokens.safeParse(res.json);
      if (res.status !== 200 || !tokens.success) return err("rejected");
      const state = toState(tokens.data);
      await this.d.store.write(state);
      return ok(state);
    } catch (e) {
      return err(e instanceof NetworkError ? "network" : "rejected");
    }
  }

  /** Both steps in one call, for callers that have a CredentialPort (tests, native shells). */
  async signInWithPasskey(): Promise<Result<SessionState, SessionFailure>> {
    const opts = await this.beginPasskey();
    if (!opts.ok) return opts;
    const cred = await this.d.credentials.getAssertion({ challenge: opts.value.challenge, rpId: opts.value.rp_id });
    if (!cred.ok) return err(cred.error);
    return this.completePasskey(opts.value.challenge_id, cred.value);
  }

  async verifyTotp(code: string): Promise<Result<SessionState, SessionFailure>> {
    z.string().regex(/^\d{6}$/).parse(code);
    return err("totp_unavailable");
  }

  async refresh(): Promise<Result<SessionState, SessionFailure>> {
    const cur = await this.d.store.read();
    if (cur === null) return err("rejected");
    try {
      const res = await this.d.transport.send({ method: "POST", path: "/v1/auth/refresh", body: { refresh_token: cur.refreshToken, device_install_id: this.d.installId() } });
      const tokens = sessionTokens.safeParse(res.json);
      if (res.status !== 200 || !tokens.success) {
        await this.d.store.write(null);
        return err("rejected");
      }
      const state = toState(tokens.data);
      await this.d.store.write(state);
      return ok(state);
    } catch (e) {
      return err(e instanceof NetworkError ? "network" : "rejected");
    }
  }

  async signOut(): Promise<void> {
    const cur = await this.d.store.read();
    await this.d.store.write(null);
    if (cur === null) return;
    try {
      await this.d.transport.send({
        method: "POST",
        path: "/v1/auth/logout",
        headers: { authorization: `Bearer ${cur.accessToken}`, "idempotency-key": this.d.newIdempotencyKey() },
        body: {},
      });
    } catch {
      // Local state is already cleared; server-side revocation is best effort.
    }
  }
}
