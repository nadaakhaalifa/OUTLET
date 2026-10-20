import { readFileSync } from "node:fs";
import { z } from "zod";
import type { PaymobHttpRequest, PaymobTransport, PaymobTransportOutcome } from "./transport";

const FixtureFile = z.object({ _provenance: z.string().min(20), status: z.number().int(), body: z.unknown() });
export type PaymobFixtureName = string;

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);

export function loadFixture(name: PaymobFixtureName): { status: number; body: unknown } {
  const parsed = FixtureFile.parse(JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8")));
  return { status: parsed.status, body: parsed.body };
}

export type FixtureScript = PaymobFixtureName | { readonly kind: "timeout" } | { readonly kind: "connect_error" };

const DEFAULTS: Readonly<Record<string, string>> = {
  capture: "capture.ok",
  void: "void.ok",
  refund: "refund.ok",
  retrieve: "retrieve.succeeded",
  delete_token: "delete-token.ok",
};

/**
 * Replays hand-authored fixtures. Not a mock of behaviour: it returns a fixed document per
 * operation (and per payment method for `create_intention`) unless a scenario is queued with
 * `script`. It records every request so tests can assert what would have gone on the wire.
 */
export class FixtureTransport implements PaymobTransport {
  readonly requests: PaymobHttpRequest[] = [];
  private readonly queue: FixtureScript[] = [];

  script(...next: FixtureScript[]): this {
    this.queue.push(...next);
    return this;
  }

  async send(req: PaymobHttpRequest): Promise<PaymobTransportOutcome> {
    this.requests.push(req);
    const scripted = this.queue.shift();
    if (scripted !== undefined) {
      if (typeof scripted !== "string") return scripted;
      const f = loadFixture(scripted);
      return { kind: "response", status: f.status, body: f.body };
    }
    const name =
      req.op === "create_intention"
        ? `create-intention.${req.meta.paymentMethod === "meeza" ? "card" : (req.meta.paymentMethod ?? "card")}`
        : DEFAULTS[req.op];
    if (name === undefined) return { kind: "connect_error" };
    const f = loadFixture(name);
    return { kind: "response", status: f.status, body: f.body };
  }
}
