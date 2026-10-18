import { passkeyOptions, sessionTokens, type PasskeyOptions } from "../api/schemas";
import { NetworkError, type Transport } from "../api/transport";
import { err, ok, type Result } from "../lib/result";
import { INSTALL_HEADER, parseInstallToken, type InstallTokenStore } from "./install-token";
import { toState, type CredentialPort, type SessionFailure, type SessionPort, type SessionState, type SessionStore } from "./port";

export interface ApiSessionDeps {
  readonly transport: Transport;
  readonly store: SessionStore;
  readonly credentials: CredentialPort;
  /** Holds the SERVER-minted install token (httpOnly cookie in production). The client never makes one up. */
  readonly installTokens: InstallTokenStore;
  readonly newIdempotencyKey: () => string;
}

/**
 * SessionPort over /v1/auth/passkey/assert/options, /v1/auth/passkey/assert, /v1/auth/refresh, /v1/auth/logout.
 * Web sign-in (spec track 1): the assertion carries `device: {platform: "web"}` and no install id. The server
 * answers with `install_token`, which is kept in the install-token store and sent as `X-Admin-Install` on refresh.
 * A response without a token is refused, not stored: such a session could never refresh.
 */
export class ApiSession implements SessionPort {
  constructor(private readonly d: ApiSessionDeps) {}

  current(): Promise<SessionState | null> {
    return this.d.store.read();
  }

  /** Step 1 of the two-step web flow: ask the server for a challenge. */
  async beginPasskey(): Promise<Result<PasskeyOptions, SessionFailure>> {
    try {
      const res = await this.d.transport.send({ method: "POST", path: "/v1/auth/passkey/assert/options", body: {} });
      const opts = passkeyOptions.safeParse(res.json);
      return res.status === 200 && opts.success ? ok(opts.data) : err("rejected");
    } catch (e) {
      return err(e instanceof NetworkError ? "network" : "rejected");
    }
  }

  /** Step 2: exchange the browser's assertion for tokens. A token that wants a second factor is refused. */
  async completePasskey(challengeId: string, credential: unknown): Promise<Result<SessionState, SessionFailure>> {
    try {
      const res = await this.d.transport.send({
        method: "POST",
        path: "/v1/auth/passkey/assert",
        headers: { "idempotency-key": this.d.newIdempotencyKey() },
        body: { challenge_id: challengeId, credential, device: { platform: "web" } },
      });
      const tokens = sessionTokens.safeParse(res.json);
      if (res.status !== 200 || !tokens.success || tokens.data.second_factor_required === true) return err("rejected");
      const install = parseInstallToken(tokens.data.install_token);
      if (install === null) return err("rejected");
      // Rotated at every login: the new value replaces the old one before the new session is stored.
      await this.d.installTokens.write(install);
      const state = toState(tokens.data);
      await this.d.store.write(state);
      return ok(state);
    } catch (e) {
      return err(e instanceof NetworkError ? "network" : "rejected");
    }
  }

  async signInWithPasskey(): Promise<Result<SessionState, SessionFailure>> {
    const opts = await this.beginPasskey();
    if (!opts.ok) return opts;
    const cred = await this.d.credentials.getAssertion({ challenge: opts.value.challenge, rpId: opts.value.rp_id });
    if (!cred.ok) return err(cred.error);
    return this.completePasskey(opts.value.challenge_id, cred.value);
  }

  async refresh(): Promise<Result<SessionState, SessionFailure>> {
    const cur = await this.d.store.read();
    if (cur === null) return err("rejected");
    const install = await this.d.installTokens.read();
    try {
      const res = await this.d.transport.send({
        method: "POST",
        path: "/v1/auth/refresh",
        headers: install === null ? {} : { [INSTALL_HEADER]: install },
        body: { refresh_token: cur.refreshToken },
      });
      const tokens = sessionTokens.safeParse(res.json);
      if (res.status !== 200 || !tokens.success || tokens.data.second_factor_required === true) {
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
    await this.d.installTokens.write(null);
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
