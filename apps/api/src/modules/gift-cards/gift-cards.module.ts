import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { GiftCardsAdminController } from "./adapters/admin.controller";
import { GiftCardsController } from "./adapters/gift-cards.controller";
import { AdminVoidGiftCard, ListAdminPots, ListThrottleEvents } from "./application/admin";
import {
  DevAesGcmFieldCipher,
  FakeAgeGate,
  FakeAudit,
  FakeDelivery,
  FakeFlags,
  FakePayments,
  FakeSecret,
  FakeStoreCredit,
  FakeVoidApprovals,
  DenyVoidApprovals,
  InMemoryGiftCardStore,
  NodeRandom,
} from "./adapters/in-memory";
import { CardResolver, GiftCardAdminResolver, PotResolver } from "./adapters/resolvers";
import * as T from "./adapters/tokens";
import {
  CancelUnpaidCard,
  ConfirmDelivered,
  ExpireGiftCards,
  IssueOnPayment,
  ListMyGiftCards,
  PurchaseGiftCard,
  VoidGiftCard,
} from "./application/purchase";
import {
  ClosePot,
  CloseDuePots,
  ConfirmContribution,
  ContributeToPot,
  CreateGiftPot,
  GetMyPot,
  GetSharedPot,
  RefundUnfundedPot,
} from "./application/pots";
import { RedeemGiftCard, ResumePendingRedemptions } from "./application/redeem";
import type { GiftCardDeps } from "./application/shared";
import type {
  AgeGatePort,
  AuditPort,
  DeliveryPort,
  FieldCipherPort,
  GiftCardFlagsPort,
  GiftCardStore,
  PaymentIntentPort,
  RandomPort,
  SecretPort,
  StoreCreditPort,
  VoidApprovalPort,
} from "./domain/ports";

export interface GiftCardsModuleOptions {
  /** Replaces the in-memory store (KyselyGiftCardStore) once persistence is wired. */
  readonly store?: GiftCardStore;
  readonly secret?: SecretPort;
  readonly random?: RandomPort;
  readonly cipher?: FieldCipherPort;
  readonly storeCredit?: StoreCreditPort;
  readonly audit?: AuditPort;
  readonly flags?: GiftCardFlagsPort;
  readonly age?: AgeGatePort;
  readonly payments?: PaymentIntentPort;
  readonly delivery?: DeliveryPort;
  /** Admin dual approval (consume once) for voids at or above the refund threshold. */
  readonly approvals?: VoidApprovalPort;
}

/**
 * Thrown outside test mode when a port owned by another module is missing: the HMAC key, the
 * ledger, the kill switches and the PSP must never be development fixtures in production.
 */
export class MissingGiftCardPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`GiftCardsModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingGiftCardPortsError";
  }
}

@Module({})
export class GiftCardsModule {
  static forRoot(config: AppConfig, o: GiftCardsModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.secret === undefined) missing.push("secret (KMS HMAC key, versioned)");
      if (o.cipher === undefined) missing.push("cipher (KMS envelope field encryption)");
      if (o.storeCredit === undefined) missing.push("storeCredit (store-credit module, ADR-0021 posting)");
      if (o.audit === undefined) missing.push("audit (hash-chained audit log)");
      if (o.flags === undefined) missing.push("flags (kill.gift_card_sales, kill.gift_card_redemption)");
      if (o.age === undefined) missing.push("age (privacy age bands)");
      if (o.payments === undefined) missing.push("payments (PSP intents and refunds)");
      if (o.delivery === undefined) missing.push("delivery (notifications provider)");
      if (missing.length > 0) throw new MissingGiftCardPortsError(missing);
    }
    const store = o.store ?? new InMemoryGiftCardStore();
    const ports = {
      secret: o.secret ?? new FakeSecret(),
      random: o.random ?? new NodeRandom(),
      cipher: o.cipher ?? new DevAesGcmFieldCipher(),
      storeCredit: o.storeCredit ?? new FakeStoreCredit(),
      audit: o.audit ?? new FakeAudit(),
      flags: o.flags ?? new FakeFlags(),
      age: o.age ?? new FakeAgeGate(),
      payments: o.payments ?? new FakePayments(),
      delivery: o.delivery ?? new FakeDelivery(),
    };

    const approvals = o.approvals ?? (config.env === "test" || !production ? new FakeVoidApprovals() : new DenyVoidApprovals());
    const runtime = (clock: Clock, ids: IdGenerator) => {
      const d: GiftCardDeps = { store, clock, ids, ...ports };
      const close = new ClosePot(d);
      const refund = new RefundUnfundedPot(d);
      return {
        purchase: new PurchaseGiftCard(d),
        issue: new IssueOnPayment(d),
        cancel: new CancelUnpaidCard(d),
        delivered: new ConfirmDelivered(d),
        redeem: new RedeemGiftCard(d),
        resume: new ResumePendingRedemptions(d),
        voidCard: new VoidGiftCard(d),
        adminVoid: new AdminVoidGiftCard(d, approvals),
        adminPots: new ListAdminPots(d),
        throttle: new ListThrottleEvents(d),
        list: new ListMyGiftCards(d),
        expire: new ExpireGiftCards(d),
        createPot: new CreateGiftPot(d),
        contribute: new ContributeToPot(d),
        confirm: new ConfirmContribution(d, close),
        close,
        refund,
        due: new CloseDuePots(d, close, refund),
        shared: new GetSharedPot(d),
        myPot: new GetMyPot(d),
      };
    };
    const RUNTIME = Symbol("giftCards.Runtime");
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });

    return {
      module: GiftCardsModule,
      controllers: [GiftCardsController, GiftCardsAdminController],
      providers: [
        { provide: T.GIFT_CARD_STORE, useValue: store },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: Clock, ids: IdGenerator) => runtime(c, ids) },
        { provide: T.CARD_RESOLVER, useValue: new CardResolver(store) },
        { provide: T.POT_RESOLVER, useValue: new PotResolver(store) },
        from(T.PURCHASE_GIFT_CARD, (r) => r.purchase),
        from(T.ISSUE_ON_PAYMENT, (r) => r.issue),
        from(T.CANCEL_UNPAID_CARD, (r) => r.cancel),
        from(T.CONFIRM_DELIVERED, (r) => r.delivered),
        from(T.REDEEM_GIFT_CARD, (r) => r.redeem),
        from(T.RESUME_PENDING_REDEMPTIONS, (r) => r.resume),
        from(T.VOID_GIFT_CARD, (r) => r.voidCard),
        from(T.ADMIN_VOID_GIFT_CARD, (r) => r.adminVoid),
        from(T.LIST_ADMIN_POTS, (r) => r.adminPots),
        from(T.LIST_THROTTLE_EVENTS, (r) => r.throttle),
        { provide: T.GIFT_CARD_ADMIN_RESOLVER, useValue: new GiftCardAdminResolver() },
        from(T.LIST_MY_GIFT_CARDS, (r) => r.list),
        from(T.EXPIRE_GIFT_CARDS, (r) => r.expire),
        from(T.CREATE_GIFT_POT, (r) => r.createPot),
        from(T.CONTRIBUTE_TO_POT, (r) => r.contribute),
        from(T.CONFIRM_CONTRIBUTION, (r) => r.confirm),
        from(T.CLOSE_POT, (r) => r.close),
        from(T.REFUND_UNFUNDED_POT, (r) => r.refund),
        from(T.CLOSE_DUE_POTS, (r) => r.due),
        from(T.GET_SHARED_POT, (r) => r.shared),
        from(T.GET_MY_POT, (r) => r.myPot),
      ],
      exports: [
        T.GIFT_CARD_STORE,
        T.ISSUE_ON_PAYMENT,
        T.CANCEL_UNPAID_CARD,
        T.CONFIRM_DELIVERED,
        T.EXPIRE_GIFT_CARDS,
        T.RESUME_PENDING_REDEMPTIONS,
        T.CONFIRM_CONTRIBUTION,
        T.CLOSE_DUE_POTS,
      ],
    };
  }
}
