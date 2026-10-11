/** Runs the shared suites against the in-repo fakes: the baseline every real adapter must match. */
import { FakePaymentProvider } from "../../../../apps/api/src/modules/payments/adapters/fake-provider";
import { FakeBostaCourier } from "../../../../apps/api/src/modules/fulfillment/adapters/bosta/fake-bosta";
import { FakeEtaPort } from "../../../../apps/api/src/modules/tax-eta/adapters/in-memory";
import { courierContract } from "./courier.contract";
import { etaContract } from "./eta.contract";
import { paymentProviderContract } from "./payment-provider.contract";

paymentProviderContract("FakePaymentProvider", () => {
  const fake = new FakePaymentProvider();
  return {
    port: fake,
    markPaid: (g) => fake.setRemoteStatus(g, "SUCCEEDED"),
    failNext: (op, f) => fake.failNext(op, f),
    signedWebhook: (body) => fake.signedWebhook(body),
  };
});

courierContract("FakeBostaCourier", () => {
  const fake = new FakeBostaCourier();
  return {
    port: fake,
    goDown: () => {
      fake.mode = "down";
    },
    rejectAll: () => {
      fake.mode = "reject";
    },
  };
});

etaContract("FakeEtaPort", () => ({ port: new FakeEtaPort() }));
