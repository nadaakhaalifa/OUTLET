import assert from "node:assert/strict";
import type { ChannelProvider, ProviderMessage } from "../../../modules/notifications";
import type { ExternalChannel } from "../../../modules/notifications/domain/types";
import { httpDeps, type CommsLogEvent, type HttpDeps } from "./core";

/**
 * Vendor-neutral conformance suite for communication adapters (ADR-0034). Tooling free: it uses
 * node:assert and a fake fetch, and returns named cases that any test runner can register. A new
 * vendor adapter is accepted only when `channelConformanceCases` passes for it.
 * All fixtures passed in by harnesses are HAND-AUTHORED from public docs (VERIFY BEFORE LAUNCH).
 */

export type FakeStep = Response | Error | "hang";

/** Records every request and answers from a queue. Never touches the network. */
export class FakeFetch {
  readonly requests: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  private readonly queue: FakeStep[] = [];
  enqueue(...steps: FakeStep[]): this {
    this.queue.push(...steps);
    return this;
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    this.requests.push({ url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : "" });
    const step = this.queue.shift();
    if (step === undefined) throw new Error("FakeFetch: no response queued");
    if (step === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (step instanceof Error) throw step;
    return step;
  };
}

export const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function testHttp(fake: FakeFetch, log: CommsLogEvent[] = []): HttpDeps {
  return httpDeps({ fetch: fake.fetch, sleep: async () => undefined, log: (e) => log.push(e), timeoutMs: 25 });
}

export interface ChannelHarness<C extends ExternalChannel> {
  readonly name: string;
  readonly build: (http: HttpDeps) => ChannelProvider<C>;
  readonly message: ProviderMessage & { readonly channel: C };
  /** Factories, because a Response body can be read once. */
  readonly responses: {
    readonly ok: () => Response;
    readonly serverError: () => Response;
    /** 4xx that is a permanent refusal but not a bad recipient. */
    readonly permanent: () => Response;
    /** 2xx whose body does not match the documented shape. */
    readonly malformed: () => Response;
    readonly invalidRecipient?: () => Response;
  };
  /** True when the vendor call is idempotent so 5xx is retried; false means exactly one request. */
  readonly retriesServerError: boolean;
  /** Strings that must never appear in logs or error text (token, address, body). */
  readonly secrets: readonly string[];
}

export interface ConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

export function channelConformanceCases<C extends ExternalChannel>(h: ChannelHarness<C>): readonly ConformanceCase[] {
  const setup = (...steps: FakeStep[]) => {
    const fake = new FakeFetch().enqueue(...steps);
    const log: CommsLogEvent[] = [];
    return { fake, log, provider: h.build(testHttp(fake, log)) };
  };
  return [
    {
      name: `${h.name}: happy path returns sent with a provider reference after exactly one request`,
      async run() {
        const { fake, provider } = setup(h.responses.ok());
        const r = await provider.send(h.message);
        assert.equal(r.kind, "sent");
        if (r.kind === "sent") assert.ok(r.providerRef.length > 0);
        assert.equal(fake.requests.length, 1);
      },
    },
    {
      name: `${h.name}: 5xx maps to unavailable (${h.retriesServerError ? "retried" : "single attempt"})`,
      async run() {
        const steps = [h.responses.serverError(), h.responses.serverError(), h.responses.serverError()];
        const { fake, provider } = setup(...steps);
        assert.deepEqual(await provider.send(h.message), { kind: "unavailable" });
        if (h.retriesServerError) assert.ok(fake.requests.length > 1);
        else assert.equal(fake.requests.length, 1, "non-idempotent call must not be retried on 5xx");
      },
    },
    {
      name: `${h.name}: permanent 4xx is never retried and never unavailable`,
      async run() {
        const { fake, provider } = setup(h.responses.permanent());
        const r = await provider.send(h.message);
        assert.ok(r.kind === "failed" || r.kind === "template_rejected" || r.kind === "invalid_recipient", `got ${r.kind}`);
        assert.equal(fake.requests.length, 1);
      },
    },
    {
      name: `${h.name}: malformed 2xx is drift (failed, not sent, not retried)`,
      async run() {
        const { fake, provider } = setup(h.responses.malformed());
        assert.deepEqual(await provider.send(h.message), { kind: "failed", code: "provider_drift" });
        assert.equal(fake.requests.length, 1);
      },
    },
    {
      name: `${h.name}: timeout maps to unavailable`,
      async run() {
        const { provider } = setup("hang", "hang", "hang");
        assert.deepEqual(await provider.send(h.message), { kind: "unavailable" });
      },
    },
    {
      name: `${h.name}: network error maps to unavailable`,
      async run() {
        const { provider } = setup(new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET"));
        assert.deepEqual(await provider.send(h.message), { kind: "unavailable" });
      },
    },
    {
      name: `${h.name}: logs carry no tokens, recipients or message text`,
      async run() {
        const { log, provider } = setup(h.responses.ok(), h.responses.permanent());
        await provider.send(h.message);
        await provider.send(h.message);
        const blob = JSON.stringify(log);
        for (const s of h.secrets) assert.ok(!blob.includes(s), "a secret leaked into a log event");
      },
    },
    ...(h.responses.invalidRecipient === undefined
      ? []
      : [
          {
            name: `${h.name}: unknown recipient maps to invalid_recipient`,
            async run() {
              const inv = h.responses.invalidRecipient;
              assert.ok(inv !== undefined);
              const { provider } = setup(inv());
              assert.deepEqual(await provider.send(h.message), { kind: "invalid_recipient" });
            },
          } satisfies ConformanceCase,
        ]),
  ];
}
