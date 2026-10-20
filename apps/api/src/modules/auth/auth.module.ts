import { randomBytes } from "node:crypto";
import { Global, Module, type DynamicModule, type Provider } from "@nestjs/common";
import type { AttestationVerifier, Csprng, OtpSender, PasskeyVerifier } from "@outlet/auth-core";
import type { Authenticator } from "../../platform/ports";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { AUTHENTICATOR, CLOCK, CSPRNG, ID_GENERATOR } from "../../platform/tokens";
import {
  ADMIN_GRANT_READER,
  AGE_GATE,
  AGE_GATE_STORE,
  AUTH_ATTESTATION,
  AUTH_EVENTS,
  AUTH_OTP_SENDERS,
  DEV_OTP_MAILBOX,
  GET_ME,
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
import { SellerAuthController } from "./seller/adapters/seller-auth.controller";
import { SELLER_MEMBERSHIPS } from "./seller/adapters/tokens";
import { sellerProviders } from "./seller/seller.providers";
import { createInMemorySellerStores, InMemorySellerAuthEvents } from "./seller/adapters/in-memory";
import { createKyselySellerStores, KyselySellerAuthEvents } from "./seller/adapters/kysely-stores";
import { SellerActorDirectory, membershipsPortFor } from "./seller/application/team";
import type { SellerAuthEvents, SellerStores } from "./seller/domain/ports";
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
  InMemoryAdminGrantReader,
  UnconfiguredAdminGrantReader,
  InMemoryAgeGateStore,
  InMemoryAuthEventPublisher,
  InMemoryNonceStore,
  InMemoryPasskeyChallengeStore,
  InMemoryPasskeyCredentialRepository,
} from "./adapters/in-memory-identity";
import { JwtIdentityVerifier, type JwksKeyFetcher } from "./adapters/jwt-identity-verifier";
import {
  KyselyAgeGateStore,
  KyselyAuthEventPublisher,
  KyselyNonceStore,
  KyselyOtpChallengeRepository,
  KyselyOtpSendLog,
  KyselyPasskeyChallengeStore,
  KyselyPasskeyCredentialRepository,
  KyselySessionRepository,
  KyselyUserDirectory,
  type AuthDb,
} from "./adapters/kysely-stores";
import { CachingJwksKeyFetcher, NodeJwksHttp, type JwksHttp } from "./adapters/provider-jwks-fetcher";
import { JoseTokenService, type TokenKeySource } from "./adapters/token-service";
import { SimpleWebAuthnVerifier } from "./adapters/webauthn-verifier";
import type {
  AccessTokenIssuer,
  AdminGrantReader,
  AgeGateStore,
  AuthEventPublisher,
  FieldCipher,
  NonceStore,
  OtpChallengeRepository,
  OtpSendLog,
  PasskeyChallengeStore,
  PasskeyCredentialRepository,
  SessionRepository,
  UserDirectory,
} from "./domain/ports";
import { AgeGate } from "./application/age-gate";
import { PasskeyService } from "./application/passkeys";
import { RequestOtp } from "./application/request-otp";
import { SessionIssuer } from "./application/session-issuer";
import { GetMe, GetSession, ListSessions, RefreshSession, RevokeSession } from "./application/sessions";
import { SocialLogin } from "./application/social-login";
import { VerifyOtp } from "./application/verify-otp";
import { RecycledNumberStepUp } from "./application/step-up";

const APPLE_ISSUERS = ["https://appleid.apple.com"] as const;
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;

/** Default key fetcher: no provider JWKS endpoint is reachable in Phase 0, so social sign-in fails closed (503). */
class UnconfiguredJwksKeyFetcher implements JwksKeyFetcher {
  async getKey(): Promise<never> {
    throw new Error("no JWKS key fetcher configured");
  }
}

interface AuthDeps {
  readonly challenges: OtpChallengeRepository;
  readonly sendLog: OtpSendLog;
  readonly sessions: SessionRepository;
  readonly users: UserDirectory;
  readonly tokens: AccessTokenIssuer;
  readonly authenticator: Authenticator;
  readonly pepper: Uint8Array;
  readonly ageSecret: Uint8Array;
  readonly nonces: NonceStore;
  readonly passkeyChallenges: PasskeyChallengeStore;
  readonly passkeyCredentials: PasskeyCredentialRepository;
  /** Present in production (encrypts the DOB held with an age pass); dev fixtures store no ciphertext. */
  readonly cipher?: FieldCipher;
  readonly sellerStores: SellerStores;
  readonly sellerEvents: SellerAuthEvents;
}

/**
 * Everything the production auth module needs from outside. Each provider is an explicit port;
 * composition binds Unconfigured adapters (503 / 401, fail closed) until the operator supplies a
 * real one. No default here ever "works" without configuration.
 */
export interface AuthProductionPorts {
  readonly db: AuthDb;
  /** P3 field encryption and blind indexes (`kms.envelope`). */
  readonly cipher: FieldCipher;
  /** Access token signing keys (`secrets.manager`). */
  readonly keySource: TokenKeySource;
  /** App Attest / Play Integrity (`attestation.app-attest`). */
  readonly attestation: AttestationVerifier;
  /** SMS / WhatsApp providers in failover order (`messaging.sms-whatsapp`). */
  readonly senders: readonly OtpSender[];
  /** Transport for Apple / Google JWKS; defaults to the SSRF-guarded Node transport. */
  readonly jwksHttp?: JwksHttp;
  /** Defaults to the @simplewebauthn/server adapter bound to PASSKEY_RP_ID / PASSKEY_ORIGIN. */
  readonly passkeyVerifier?: PasskeyVerifier;
  /** Standing admin grant source for the web sign-in gate. Defaults to Unconfigured (nobody may sign in on web). */
  readonly adminGrants?: AdminGrantReader;
}

/**
 * Global only so that the platform's authentication guard can consume AUTHENTICATOR without the
 * platform importing a feature module. It exports nothing else.
 */
@Global()
@Module({})
export class AuthModule {
  static forRoot(config: AppConfig, production?: AuthProductionPorts): DynamicModule {
    if (config.adapters !== "in-memory-dev" && production === undefined) throw new NoProductionAdaptersError();
    const modeProviders: Provider[] =
      production === undefined || config.adapters === "in-memory-dev"
        ? AuthModule.devProviders(config)
        : AuthModule.productionProviders(config, production);
    return {
      module: AuthModule,
      controllers: [AuthController, IdentityController, SellerAuthController],
      providers: [
        ...modeProviders,
        ...sellerProviders(config),
        {
          provide: GET_ME,
          inject: ["AUTH_DEPS"],
          useFactory: (d: AuthDeps) => new GetMe(d.users),
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
          inject: [AGE_GATE_STORE, AUTH_EVENTS, CLOCK, "AUTH_DEPS", AUTH_ATTESTATION],
          useFactory: (
            store: AgeGateStore,
            events: AuthEventPublisher,
            clock: Clock,
            deps: AuthDeps,
            attestation: AttestationVerifier,
          ) =>
            new AgeGate({
              attestation,
              store,
              events,
              clock,
              secret: deps.ageSecret,
              ...(deps.cipher === undefined ? {} : { cipher: deps.cipher }),
            }),
        },
        {
          provide: REQUEST_OTP,
          inject: [AUTH_OTP_SENDERS, CLOCK, CSPRNG, ID_GENERATOR, "AUTH_DEPS", AGE_GATE, AUTH_ATTESTATION],
          useFactory: (
            senders: readonly OtpSender[],
            clock: Clock,
            rng: Csprng,
            ids: IdGenerator,
            deps: AuthDeps,
            ageGate: AgeGate,
            attestation: AttestationVerifier,
          ) =>
            new RequestOtp({
              attestation,
              senders,
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
          inject: [CLOCK, CSPRNG, ID_GENERATOR, "AUTH_DEPS", SESSION_ISSUER, AUTH_ATTESTATION, AGE_GATE, PASSKEYS, AUTH_EVENTS],
          useFactory: (
            clock: Clock,
            rng: Csprng,
            ids: IdGenerator,
            deps: AuthDeps,
            issuer: SessionIssuer,
            attestation: AttestationVerifier,
            ageGate: AgeGate,
            passkeys: PasskeyService,
            events: AuthEventPublisher,
          ) =>
            new VerifyOtp({
              attestation,
              challenges: deps.challenges,
              users: deps.users,
              issuer,
              clock,
              rng,
              newId: () => ids.uuidV7(),
              pepper: deps.pepper,
              ageGate,
              stepUp: new RecycledNumberStepUp({ sessions: deps.sessions, events, passkeyChallenges: passkeys }),
            }),
        },
        {
          provide: SOCIAL_LOGIN,
          inject: [JWKS_KEY_FETCHER, CLOCK, ID_GENERATOR, "AUTH_DEPS", SESSION_ISSUER, AGE_GATE, AUTH_ATTESTATION],
          useFactory: (
            keys: JwksKeyFetcher,
            clock: Clock,
            ids: IdGenerator,
            deps: AuthDeps,
            issuer: SessionIssuer,
            ageGate: AgeGate,
            attestation: AttestationVerifier,
          ) =>
            new SocialLogin({
              attestation,
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
          inject: [PASSKEY_VERIFIER, CLOCK, CSPRNG, ID_GENERATOR, "AUTH_DEPS", SESSION_ISSUER, AGE_GATE, AUTH_EVENTS, AUTH_ATTESTATION, ADMIN_GRANT_READER],
          useFactory: (
            verifier: PasskeyVerifier,
            clock: Clock,
            rng: Csprng,
            ids: IdGenerator,
            deps: AuthDeps,
            issuer: SessionIssuer,
            ageGate: AgeGate,
            events: AuthEventPublisher,
            attestation: AttestationVerifier,
            adminGrants: AdminGrantReader,
          ) =>
            new PasskeyService({
              verifier,
              attestation,
              challenges: deps.passkeyChallenges,
              credentials: deps.passkeyCredentials,
              users: deps.users,
              sessions: deps.sessions,
              issuer,
              ageGate,
              adminGrants,
              events,
              clock,
              rng,
              newId: () => ids.uuidV7(),
              rpId: config.passkeyRpId,
              deviceKeyOf: (k: string) => deps.challenges.deviceKeyOf(k),
            }),
        },
        {
          provide: REFRESH_SESSION,
          inject: ["AUTH_DEPS", SESSION_ISSUER, AUTH_EVENTS, CLOCK, CSPRNG, ID_GENERATOR],
          useFactory: (
            deps: AuthDeps,
            issuer: SessionIssuer,
            events: AuthEventPublisher,
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
          useFactory: (d: AuthDeps, clock: Clock, events: AuthEventPublisher) =>
            new RevokeSession(d.sessions, clock, events),
        },
        { provide: SESSION_RESOLVER, inject: ["AUTH_DEPS"], useFactory: (d: AuthDeps) => new SessionResourceResolver(d.sessions) },
        { provide: AUTHENTICATOR, inject: ["AUTH_DEPS"], useFactory: (d: AuthDeps) => d.authenticator },
      ],
      exports: [AUTHENTICATOR, SELLER_MEMBERSHIPS],
    };
  }

  private static productionProviders(config: AppConfig, ports: AuthProductionPorts): Provider[] {
    // loadConfig makes both mandatory when NODE_ENV=production; a non-production boot with fixtures
    // off (tests, staging smoke) gets a per-process random secret instead of an empty one.
    const secret = (value: string | undefined, name: string): Uint8Array => {
      if (value !== undefined) return new TextEncoder().encode(value);
      if (config.env === "production") throw new Error(`${name} is required in production`);
      return new Uint8Array(randomBytes(32));
    };
    const pepper = secret(config.otpPepper, "OTP_PEPPER");
    const ageSecret = secret(config.ageBlockKey, "AGE_BLOCK_KEY");
    return [
      { provide: AUTH_ATTESTATION, useValue: ports.attestation },
      { provide: ADMIN_GRANT_READER, useValue: ports.adminGrants ?? new UnconfiguredAdminGrantReader() },
      { provide: AUTH_OTP_SENDERS, useValue: ports.senders },
      { provide: AUTH_EVENTS, inject: [ID_GENERATOR], useFactory: (ids: IdGenerator) => new KyselyAuthEventPublisher(ports.db, () => ids.uuidV7()) },
      { provide: AGE_GATE_STORE, useValue: new KyselyAgeGateStore(ports.db) },
      {
        provide: JWKS_KEY_FETCHER,
        inject: [CLOCK],
        useFactory: (clock: Clock) => new CachingJwksKeyFetcher({ http: ports.jwksHttp ?? new NodeJwksHttp(), clock }),
      },
      {
        provide: PASSKEY_VERIFIER,
        useValue: ports.passkeyVerifier ?? new SimpleWebAuthnVerifier({ rpId: config.passkeyRpId, origins: [config.passkeyOrigin] }),
      },
      {
        provide: "AUTH_DEPS",
        inject: [CLOCK, ID_GENERATOR],
        useFactory: (clock: Clock, ids: IdGenerator): AuthDeps => {
          const sessions = new KyselySessionRepository(ports.db);
          const users = new KyselyUserDirectory(ports.db, ports.cipher);
          const sellerStores = createKyselySellerStores(ports.db, ports.cipher);
          const sellerActors = new SellerActorDirectory(sellerStores.sessions, sellerStores.users, membershipsPortFor(sellerStores.memberships));
          const tokens = new JoseTokenService({ source: ports.keySource, sessions, users, clock, issuer: config.tokenIssuer, sellerActors });
          return {
            challenges: new KyselyOtpChallengeRepository(ports.db, ports.cipher),
            sendLog: new KyselyOtpSendLog(ports.db, ports.cipher),
            sessions,
            users,
            tokens,
            authenticator: tokens,
            pepper,
            ageSecret,
            nonces: new KyselyNonceStore(ports.db),
            passkeyChallenges: new KyselyPasskeyChallengeStore(ports.db),
            passkeyCredentials: new KyselyPasskeyCredentialRepository(ports.db),
            cipher: ports.cipher,
            sellerStores,
            sellerEvents: new KyselySellerAuthEvents(ports.db, () => ids.uuidV7()),
          };
        },
      },
    ];
  }

  private static devProviders(config: AppConfig): Provider[] {
    return [
        { provide: DEV_OTP_MAILBOX, useValue: new DevOtpMailbox() },
        { provide: AUTH_EVENTS, useValue: new InMemoryAuthEventPublisher() },
        { provide: AGE_GATE_STORE, useValue: new InMemoryAgeGateStore() },
        { provide: JWKS_KEY_FETCHER, useValue: new UnconfiguredJwksKeyFetcher() },
        { provide: PASSKEY_VERIFIER, useValue: new DevPasskeyVerifier(config.passkeyOrigin) },
        { provide: AUTH_ATTESTATION, useValue: new DevAttestationVerifier() },
        { provide: ADMIN_GRANT_READER, useValue: new InMemoryAdminGrantReader() },
        {
          provide: AUTH_OTP_SENDERS,
          inject: [DEV_OTP_MAILBOX],
          useFactory: (mailbox: DevOtpMailbox) => [new DevOtpSender("sms", mailbox), new DevOtpSender("whatsapp", mailbox)],
        },
        {
          provide: "AUTH_DEPS",
          inject: [CSPRNG, CLOCK],
          useFactory: (rng: Csprng): AuthDeps => {
            const sessions = new InMemorySessionRepository();
            const users = new InMemoryUserDirectory();
            const sellerStores = createInMemorySellerStores();
            const sellerActors = new SellerActorDirectory(sellerStores.sessions, sellerStores.users, membershipsPortFor(sellerStores.memberships));
            const tokens = new DevTokenService(rng, sessions, users, sellerActors);
            return {
              challenges: new InMemoryOtpChallengeRepository(),
              sendLog: new InMemoryOtpSendLog(),
              sessions,
              users,
              tokens,
              authenticator: tokens,
              // Development: a per-boot random pepper when none is configured.
              pepper: config.otpPepper !== undefined ? new TextEncoder().encode(config.otpPepper) : rng.randomBytes(32),
              ageSecret: config.ageBlockKey !== undefined ? new TextEncoder().encode(config.ageBlockKey) : rng.randomBytes(32),
              nonces: new InMemoryNonceStore(),
              passkeyChallenges: new InMemoryPasskeyChallengeStore(),
              passkeyCredentials: new InMemoryPasskeyCredentialRepository(),
              sellerStores,
              sellerEvents: new InMemorySellerAuthEvents(),
            };
          },
        },
    ];
  }
}
