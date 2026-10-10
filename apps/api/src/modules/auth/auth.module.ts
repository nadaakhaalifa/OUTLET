import { Global, Module, type DynamicModule } from "@nestjs/common";
import type { Csprng } from "@outlet/auth-core";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { AUTHENTICATOR, CLOCK, CSPRNG, ID_GENERATOR } from "../../platform/tokens";
import {
  DEV_OTP_MAILBOX,
  GET_SESSION,
  REQUEST_OTP,
  REVOKE_SESSION,
  SESSION_RESOLVER,
  VERIFY_OTP,
} from "./adapters/tokens";
import { AuthController } from "./adapters/auth.controller";
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
import { RequestOtp } from "./application/request-otp";
import { GetSession, RevokeSession } from "./application/sessions";
import { VerifyOtp } from "./application/verify-otp";

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
      controllers: [AuthController],
      providers: [
        { provide: DEV_OTP_MAILBOX, useValue: new DevOtpMailbox() },
        {
          provide: REQUEST_OTP,
          inject: [DEV_OTP_MAILBOX, CLOCK, CSPRNG, ID_GENERATOR, "AUTH_DEPS"],
          useFactory: (
            mailbox: DevOtpMailbox,
            clock: Clock,
            rng: Csprng,
            ids: IdGenerator,
            deps: AuthDeps,
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
            }),
        },
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
            };
          },
        },
        {
          provide: VERIFY_OTP,
          inject: [CLOCK, CSPRNG, ID_GENERATOR, "AUTH_DEPS"],
          useFactory: (clock: Clock, rng: Csprng, ids: IdGenerator, deps: AuthDeps) =>
            new VerifyOtp({
              attestation: new DevAttestationVerifier(),
              challenges: deps.challenges,
              users: deps.users,
              sessions: deps.sessions,
              tokens: deps.tokens,
              clock,
              rng,
              newId: () => ids.uuidV7(),
              pepper: deps.pepper,
              issuer: config.tokenIssuer,
            }),
        },
        { provide: GET_SESSION, inject: ["AUTH_DEPS"], useFactory: (d: AuthDeps) => new GetSession(d.sessions) },
        {
          provide: REVOKE_SESSION,
          inject: ["AUTH_DEPS", CLOCK],
          useFactory: (d: AuthDeps, clock: Clock) => new RevokeSession(d.sessions, clock),
        },
        { provide: SESSION_RESOLVER, inject: ["AUTH_DEPS"], useFactory: (d: AuthDeps) => new SessionResourceResolver(d.sessions) },
        { provide: AUTHENTICATOR, inject: ["AUTH_DEPS"], useFactory: (d: AuthDeps) => d.tokens },
      ],
      exports: [AUTHENTICATOR],
    };
  }
}

interface AuthDeps {
  readonly challenges: InMemoryOtpChallengeRepository;
  readonly sendLog: InMemoryOtpSendLog;
  readonly sessions: InMemorySessionRepository;
  readonly users: InMemoryUserDirectory;
  readonly tokens: DevTokenService;
  readonly pepper: Uint8Array;
}
