import type { Provider } from "@nestjs/common";
import type { Csprng, OtpSender, PasskeyVerifier } from "@outlet/auth-core";
import type { AppConfig } from "../../../config/env";
import type { Clock, IdGenerator } from "../../../platform/ports";
import { CLOCK, CSPRNG, ID_GENERATOR } from "../../../platform/tokens";
import { AUTH_OTP_SENDERS, PASSKEY_VERIFIER } from "../adapters/tokens";
import type { AccessTokenIssuer } from "../domain/ports";
import { SellerPasskeys, SellerTotp, type FactorDeps } from "./application/factors";
import { SellerOtp } from "./application/otp";
import { SellerRefresh, SellerSessionIssuer, SellerSessions } from "./application/sessions";
import { SellerMembershipService } from "./application/team";
import type { SellerAuthEvents, SellerStores } from "./domain/ports";
import { SELLER_EVENTS, SELLER_ISSUER, SELLER_MEMBERSHIPS, SELLER_OTP, SELLER_PASSKEYS, SELLER_REFRESH, SELLER_SESSIONS, SELLER_STORES, SELLER_TOTP } from "./adapters/tokens";

/** What AuthModule's private deps must supply for the seller side. */
export interface SellerDeps {
  readonly sellerStores: SellerStores;
  readonly sellerEvents: SellerAuthEvents;
  readonly tokens: AccessTokenIssuer;
  readonly pepper: Uint8Array;
}

export function sellerProviders(config: AppConfig): Provider[] {
  return [
    { provide: SELLER_STORES, inject: ["AUTH_DEPS"], useFactory: (d: SellerDeps) => d.sellerStores },
    { provide: SELLER_EVENTS, inject: ["AUTH_DEPS"], useFactory: (d: SellerDeps) => d.sellerEvents },
    {
      provide: SELLER_MEMBERSHIPS,
      inject: ["AUTH_DEPS", CLOCK, ID_GENERATOR],
      useFactory: (d: SellerDeps, clock: Clock, ids: IdGenerator) =>
        new SellerMembershipService({
          memberships: d.sellerStores.memberships,
          invites: d.sellerStores.invites,
          users: d.sellerStores.users,
          events: d.sellerEvents,
          clock,
          newId: () => ids.uuidV7(),
        }),
    },
    {
      provide: SELLER_ISSUER,
      inject: ["AUTH_DEPS", CLOCK, CSPRNG, ID_GENERATOR],
      useFactory: (d: SellerDeps, clock: Clock, rng: Csprng, ids: IdGenerator) =>
        new SellerSessionIssuer({
          sessions: d.sellerStores.sessions,
          memberships: d.sellerStores.memberships,
          users: d.sellerStores.users,
          tokens: d.tokens,
          events: d.sellerEvents,
          clock,
          rng,
          newId: () => ids.uuidV7(),
          issuer: config.tokenIssuer,
        }),
    },
    {
      provide: SELLER_SESSIONS,
      inject: ["AUTH_DEPS", CLOCK, CSPRNG, ID_GENERATOR],
      useFactory: (d: SellerDeps, clock: Clock, rng: Csprng, ids: IdGenerator) =>
        new SellerSessions({
          sessions: d.sellerStores.sessions,
          memberships: d.sellerStores.memberships,
          users: d.sellerStores.users,
          tokens: d.tokens,
          events: d.sellerEvents,
          clock,
          rng,
          newId: () => ids.uuidV7(),
          issuer: config.tokenIssuer,
        }),
    },
    {
      provide: SELLER_REFRESH,
      inject: ["AUTH_DEPS", CLOCK, CSPRNG, ID_GENERATOR, SELLER_ISSUER],
      useFactory: (d: SellerDeps, clock: Clock, rng: Csprng, ids: IdGenerator, issuer: SellerSessionIssuer) =>
        new SellerRefresh(
          {
            sessions: d.sellerStores.sessions,
            memberships: d.sellerStores.memberships,
            users: d.sellerStores.users,
            tokens: d.tokens,
            events: d.sellerEvents,
            clock,
            rng,
            newId: () => ids.uuidV7(),
            issuer: config.tokenIssuer,
          },
          issuer,
        ),
    },
    {
      provide: SELLER_OTP,
      inject: ["AUTH_DEPS", AUTH_OTP_SENDERS, CLOCK, CSPRNG, ID_GENERATOR, SELLER_ISSUER],
      useFactory: (d: SellerDeps, senders: readonly OtpSender[], clock: Clock, rng: Csprng, ids: IdGenerator, issuer: SellerSessionIssuer) =>
        new SellerOtp({
          senders,
          challenges: d.sellerStores.challenges,
          sendLog: d.sellerStores.sendLog,
          proofs: d.sellerStores.proofs,
          users: d.sellerStores.users,
          issuer,
          events: d.sellerEvents,
          clock,
          rng,
          newId: () => ids.uuidV7(),
          pepper: d.pepper,
        }),
    },
    {
      provide: SELLER_PASSKEYS,
      inject: ["AUTH_DEPS", PASSKEY_VERIFIER, CLOCK, CSPRNG, ID_GENERATOR, SELLER_ISSUER, SELLER_SESSIONS, SELLER_MEMBERSHIPS],
      useFactory: (
        d: SellerDeps,
        verifier: PasskeyVerifier,
        clock: Clock,
        rng: Csprng,
        ids: IdGenerator,
        issuer: SellerSessionIssuer,
        sessions: SellerSessions,
        team: SellerMembershipService,
      ) => {
        const f: FactorDeps = { users: d.sellerStores.users, sessionsRepo: d.sellerStores.sessions, sessions, issuer, team, events: d.sellerEvents, clock, rng, newId: () => ids.uuidV7() };
        return new SellerPasskeys(f, verifier, d.sellerStores.passkeyChallenges, d.sellerStores.passkeys, d.sellerStores.proofs, { rpId: config.passkeyRpId, rpName: "Z-OUTLET Seller Center" });
      },
    },
    {
      provide: SELLER_TOTP,
      inject: ["AUTH_DEPS", CLOCK, CSPRNG, ID_GENERATOR, SELLER_ISSUER, SELLER_SESSIONS, SELLER_MEMBERSHIPS],
      useFactory: (
        d: SellerDeps,
        clock: Clock,
        rng: Csprng,
        ids: IdGenerator,
        issuer: SellerSessionIssuer,
        sessions: SellerSessions,
        team: SellerMembershipService,
      ) =>
        new SellerTotp({
          users: d.sellerStores.users,
          sessionsRepo: d.sellerStores.sessions,
          sessions,
          issuer,
          team,
          events: d.sellerEvents,
          clock,
          rng,
          newId: () => ids.uuidV7(),
          totp: d.sellerStores.totp,
          proofs: d.sellerStores.proofs,
          pepper: d.pepper,
          issuerName: "Z-OUTLET",
        }),
    },
  ];
}
