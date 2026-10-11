import { Global, Module, type DynamicModule } from "@nestjs/common";
import type { Csprng } from "@outlet/auth-core";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { AUTHENTICATOR, CLOCK, CSPRNG, ID_GENERATOR } from "../../platform/tokens";
import {
  AGE_GATE,
  AGE_GATE_STORE,
  AUTH_EVENTS,
  DEV_OTP_MAILBOX,
  GET_SESSION,
  JWKS_KEY_FETCHER,
  LIST_SESSIONS,
  PASSKEYS,
  PASSKEY_VERIFIER,
  REFRESH_SESSION,
  REQUEST_OTP,
  REVOKE_SESSION,
  SESSION_ISSUER,
  SESSION_RESOLVER,
  SOCIAL_LOGIN,
  VERIFY_OTP,
} from "./adapters/tokens";
import { AuthController } from "./adapters/auth.controller";
import { IdentityController } from "./adapters/identity.controller";
import {
  DevAttestationVerifier,
  DevOtpMailbox,
  DevOtpSender,
  DevTokenService,
  InMemoryOtpChallengeRepository,
  InMemoryOtpSendLog,
  InMemorySessionRepository,
  InMemoryUserDirectory,
  SessionResourceResolver,
} from "./adapters/in-memory";
import {
  DevPasskeyVerifier,
  InMemoryAgeGateStore,
  InMemoryAuthEventPublisher,
  InMemoryNonceStore,
  InMemoryPasskeyChallengeStore,
  InMemoryPasskeyCredentialRepository,
} from "./adapters/in-memory-identity";
import { JwtIdentityVerifier, type JwksKeyFetcher } from "./adapters/jwt-identity-verifier";
import { AgeGate } from "./application/age-gate";
import { PasskeyService } from "./application/passkeys";
import { RequestOtp } from "./application/request-otp";
import { SessionIssuer } from "./application/session-issuer";
import { GetSession, ListSessions, RefreshSession, RevokeSession } from "./application/sessions";
import { SocialLogin } from "./application/social-login";
import { VerifyOtp } from "./application/verify-otp";

const APPLE_ISSUERS = ["https://appleid.apple.com"] as const;
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;

/** Default key fetcher: no provider JWKS endpoint is reachable in Phase 0, so social sign-in fails closed (503). */
class UnconfiguredJwksKeyFetcher implements JwksKeyFetcher {
  async getKey(): Promise<never> {
    throw new Error("no JWKS key fetcher configured");
  }
}

interface AuthDeps {
  readonly challenges: InMemoryOtpChallengeRepository;
  readonly sendLog: InMemoryOtpSendLog;
  readonly sessions: InMemorySessionRepository;
  readonly users: InMemoryUserDirectory;
  readonly tokens: DevTokenService;
  readonly pepper: Uint8Array;
  readonly ageSecret: Uint8Array;
  readonly nonces: InMemoryNonceStore;
  readonly passkeyChallenges: InMemoryPasskeyChallengeStore;
  readonly passkeyCredentials: InMemoryPasskeyCredentialRepository;
}

/**
 * Global only so that the platform's authentication guard can consume AUTHENTICATOR without the
 * platform importing a feature module. It exports nothing else.
 */
@Global()
@Module({})
export class AuthModule {
  static forRoot(config: AppConfig): DynamicModule {
    if (config.adapters !== "in-memory-dev") throw new NoProductionAdaptersError();
    return {
      module: AuthModule,
      controllers: [AuthController, IdentityController],
      providers: [
        { provide: DEV_OTP_MAILBOX, useValue: new DevOtpMailbox() },
        { provide: AUTH_EVENTS, useValue: new InMemoryAuthEventPublisher() },
        { provide: AGE_GATE_STORE, useValue: new InMemoryAgeGateStore() },
        { provide: JWKS_KEY_FETCHER, useValue: new UnconfiguredJwksKeyFetcher() },
        { provide: PASSKEY_VERIFIER, useValue: new DevPasskeyVerifier(config.passkeyOrigin) },
        {
          provide: "AUTH_DEPS",
          inject: [CSPRNG, CLOCK],
          useFactory: (rng: Csprng): AuthDeps => {
            const sessions = new InMemorySessionRepository();
            const users = new InMemoryUserDirectory();
            return {
              challenges: new InMemoryOtpChallengeRepository(),
              sendLog: new InMemoryOtpSendLog(),
              sessions,
              users,
              tokens: new DevTokenService(rng, sessions, users),
              // Development: a per-boot random pepper when none is configured.
              pepper: config.otpPepper !== undefined ? new TextEncoder().encode(config.otpPepper) : rng.randomBytes(32),
              ageSecret: config.ageBlockKey !== undefined ? new TextEncoder().encode(config.ageBlockKey) : rng.randomBytes(32),
              nonces: new InMemoryNonceStore(),
              passkeyChallenges: new InMemoryPasskeyChallengeStore(),
              passkeyCredentials: new InMemoryPasskeyCredentialRepository(),
            };
          },
        },
        {
          provide: SESSION_ISSUER,
          inject: [CLOCK, CSPRNG, ID_GENERATOR, "AUTH_DEPS"],
          useFactory: (clock: Clock, rng: Csprng, ids: IdGenerator, deps: AuthDeps) =>
            new SessionIssuer({
              sessions: deps.sessions,
              tokens: deps.tokens,
              clock,
              rng,
              newId: () => ids.uuidV7(),
              issuer: config.tokenIssuer,
            }),
        },
        {
          provide: AGE_GATE,
          inject: [AGE_GATE_STORE, AUTH_EVENTS, CLOCK, "AUTH_DEPS"],
          useFactory: (
            store: InMemoryAgeGateStore,
            events: InMemoryAuthEventPublisher,
            clock: Clock,
            deps: AuthDeps,
          ) => new AgeGate({ attestation: new DevAttestationVerifier(), store, events, clock, secret: deps.ageSecret }),
        },
        {
          provide: REQUEST_OTP,
          inject: [DEV_OTP_MAILBOX, CLOCK, CSPRNG, ID_GENERATOR, "AUTH_DEPS", AGE_GATE],
          useFactory: (
            mailbox: DevOtpMailbox,
            clock: Clock,
            rng: Csprng,
            ids: IdGenerator,
            deps: AuthDeps,
            ageGate: AgeGate,
          ) =>
            new RequestOtp({
              attestation: new DevAttestationVerifier(),
              senders: [new DevOtpSender("sms", mailbox), new DevOtpSender("whatsapp", mailbox)],
              challenges: deps.challenges,
              sendLog: deps.sendLog,
              clock,
              rng,
              newId: () => ids.uuidV7(),
              pepper: deps.pepper,
              ageGate,
            }),
        },
        {
          provide: VERIFY_OTP,
          inject: [CLOCK, CSPRNG, ID_GENERATOR, "AUTH_DEPS", SESSION_ISSUER],
          useFactory: (clock: Clock, rng: Csprng, ids: IdGenerator, deps: AuthDeps, issuer: SessionIssuer) =>
            new VerifyOtp({
              attestation: new DevAttestationVerifier(),
              challenges: deps.challenges,
              users: deps.users,
              issuer,
              clock,
              rng,
              newId: () => ids.uuidV7(),
              pepper: deps.pepper,
            }),
        },
        {
          provide: SOCIAL_LOGIN,
          inject: [JWKS_KEY_FETCHER, CLOCK, ID_GENERATOR, "AUTH_DEPS", SESSION_ISSUER, AGE_GATE],
          useFactory: (
            keys: JwksKeyFetcher,
            clock: Clock,
            ids: IdGenerator,
            deps: AuthDeps,
            issuer: SessionIssuer,
            ageGate: AgeGate,
          ) =>
            new SocialLogin({
              attestation: new DevAttestationVerifier(),
              apple: new JwtIdentityVerifier({
                provider: "apple",
                issuers: APPLE_ISSUERS,
                audience: config.appleClientId,
                keys,
                clock,
              }),
              google: new JwtIdentityVerifier({
                provider: "google",
                issuers: GOOGLE_ISSUERS,
                audience: config.googleClientId,
                keys,
                clock,
              }),
              nonces: deps.nonces,
              users: deps.users,
              issuer,
              ageGate,
              clock,
              newId: () => ids.uuidV7(),
            }),
        },
        {
          provide: PASSKEYS,
          inject: [PASSKEY_VERIFIER, CLOCK, CSPRNG, ID_GENERATOR, "AUTH_DEPS", SESSION_ISSUER, AGE_GATE, AUTH_EVENTS],
          useFactory: (
            verifier: DevPasskeyVerifier,
            clock: Clock,
            rng: Csprng,
            ids: IdGenerator,
            deps: AuthDeps,
            issuer: SessionIssuer,
            ageGate: AgeGate,
            events: InMemoryAuthEventPublisher,
          ) =>
            new PasskeyService({
              verifier,
              attestation: new DevAttestationVerifier(),
              challenges: deps.passkeyChallenges,
              credentials: deps.passkeyCredentials,
              users: deps.users,
              sessions: deps.sessions,
              issuer,
              ageGate,
              events,
              clock,
              rng,
              newId: () => ids.uuidV7(),
              rpId: config.passkeyRpId,
            }),
        },
        {
          provide: REFRESH_SESSION,
          inject: ["AUTH_DEPS", SESSION_ISSUER, AUTH_EVENTS, CLOCK, CSPRNG, ID_GENERATOR],
          useFactory: (
            deps: AuthDeps,
            issuer: SessionIssuer,
            events: InMemoryAuthEventPublisher,
            clock: Clock,
            rng: Csprng,
            ids: IdGenerator,
          ) =>
            new RefreshSession({
              sessions: deps.sessions,
              users: deps.users,
              issuer,
              events,
              clock,
              rng,
              newId: () => ids.uuidV7(),
            }),
        },
        { provide: GET_SESSION, inject: ["AUTH_DEPS"], useFactory: (d: AuthDeps) => new GetSession(d.sessions) },
        { provide: LIST_SESSIONS, inject: ["AUTH_DEPS"], useFactory: (d: AuthDeps) => new ListSessions(d.sessions) },
        {
          provide: REVOKE_SESSION,
          inject: ["AUTH_DEPS", CLOCK, AUTH_EVENTS],
          useFactory: (d: AuthDeps, clock: Clock, events: InMemoryAuthEventPublisher) =>
            new RevokeSession(d.sessions, clock, events),
        },
        { provide: SESSION_RESOLVER, inject: ["AUTH_DEPS"], useFactory: (d: AuthDeps) => new SessionResourceResolver(d.sessions) },
        { provide: AUTHENTICATOR, inject: ["AUTH_DEPS"], useFactory: (d: AuthDeps) => d.tokens },
      ],
      exports: [AUTHENTICATOR],
    };
  }
}
