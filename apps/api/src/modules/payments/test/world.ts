import { CreatePaymentIntent, ProcessPaymentWebhook, ReceiveWebhook, RefundPayment, CapturePayment, VoidPayment, ExpirePaymentIntents, ListPaymentMethods, DeleteSavedCard, ListSavedCards } from "../application/payments";
import { PspRouter } from "../application/psp-router";
import { FakePaymentProvider } from "../adapters/fake-provider";
import { StaticPaymentMethodSwitch } from "../adapters/flag-switch";
import { InMemoryPaymentStore } from "../adapters/in-memory-store";
import { AllowAllIps } from "../adapters/ip-allowlist";
import type { PaymentProviderPort, WebhookIpAllowListPort } from "../domain/ports";
import { DEFAULT_BREAKER_CONFIG, type PaymentMethodId, type RoutePolicy } from "../domain/seam";
import { TestClock, nextId, SHOPPER_A } from "./fixtures";

export interface WorldOptions {
  readonly providers?: readonly PaymentProviderPort[];
  readonly policy?: RoutePolicy;
  readonly ipAllowList?: WebhookIpAllowListPort;
}

/** Fully wired in-memory payments stack with a deterministic clock and no sleeping. */
export function createWorld(opts: WorldOptions = {}) {
  const clock = new TestClock();
  const primary = new FakePaymentProvider("fake_psp", "primary-secret-not-real", undefined, () => clock.nowMs());
  const secondary = new FakePaymentProvider("fake_psp2", "secondary-secret-not-real", undefined, () => clock.nowMs());
  const providers = opts.providers ?? [primary, secondary];
  const policy: RoutePolicy = opts.policy ?? { order: {}, defaultOrder: providers.map((p) => p.id) };
  const store = new InMemoryPaymentStore(clock, nextId);
  const sw = new StaticPaymentMethodSwitch();
  const sleeps: number[] = [];
  const router = new PspRouter(new Map(providers.map((p) => [p.id, p] as const)), clock, {
    policy,
    breaker: DEFAULT_BREAKER_CONFIG,
    maxAttempts: 3,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
  });
  const ids = { uuidV7: nextId };
  const ip = opts.ipAllowList ?? new AllowAllIps();
  return {
    clock,
    primary,
    secondary,
    store,
    sw,
    router,
    sleeps,
    create: new CreatePaymentIntent(store, router, sw, clock, ids),
    capture: new CapturePayment(store, router),
    voidPayment: new VoidPayment(store, router),
    refund: new RefundPayment(store, router, clock, ids),
    receive: new ReceiveWebhook(store, router, ip, clock, ids),
    process: new ProcessPaymentWebhook(store, router, clock, ids),
    expire: new ExpirePaymentIntents(store, router, clock),
    methods: new ListPaymentMethods(sw, router),
    cards: new ListSavedCards(store),
    deleteCard: new DeleteSavedCard(store, router, clock),
  };
}
export type World = ReturnType<typeof createWorld>;

export const cmd = (orderGroupId: string, over: Partial<{ method: PaymentMethodId; amount: bigint; containsDropSku: boolean; userId: string }> = {}) => ({
  orderGroupId,
  userId: over.userId ?? SHOPPER_A,
  method: over.method ?? ("card" as PaymentMethodId),
  amount: over.amount ?? 125_000n,
  currency: "EGP",
  containsDropSku: over.containsDropSku ?? false,
  payer: { userId: over.userId ?? SHOPPER_A, phoneE164: "+201000000000", email: null },
});

export const webhookBody = (
  type: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type,
  event_id: `evt_${type}_${Math.abs(JSON.stringify(over).length)}`,
  provider_ref: null,
  order_group_id: null,
  amount: "125000",
  currency: "EGP",
  occurred_at_ms: 1_800_000_000_000,
  failure_code: null,
  refund_ref: null,
  ...over,
});
