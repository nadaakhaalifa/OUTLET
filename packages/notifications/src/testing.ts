import type { ChannelKillSwitchPort, ChannelPort, OutboundMessage, SendFailureCode, SendResult } from "./application/ports.js";
import type { Channel } from "./domain/types.js";

/** Scripted channel provider: results are consumed in order, then it succeeds. `sent` records what it was asked to send. */
export class FakeChannel implements ChannelPort {
  readonly sent: OutboundMessage[] = [];
  private n = 0;
  constructor(
    readonly provider: string,
    private readonly script: readonly (SendFailureCode | "ok")[] = [],
  ) {}
  send(msg: OutboundMessage): Promise<SendResult> {
    this.sent.push(msg);
    const step = this.script[this.n] ?? "ok";
    this.n += 1;
    return Promise.resolve(step === "ok" ? { ok: true, providerMsgId: `${this.provider}-${String(this.n)}` } : { ok: false, code: step });
  }
}

export class FakeKillSwitch implements ChannelKillSwitchPort {
  readonly killed = new Set<Channel>();
  isKilled(channel: Channel): Promise<boolean> {
    return Promise.resolve(this.killed.has(channel));
  }
}
