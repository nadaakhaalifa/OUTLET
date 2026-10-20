import { ACCOUNTS, quoteTopUp, topUpPostings, type TopUpQuote } from "../domain/bridge";
import type { OutboxDraft, TopUpRecord } from "../domain/ports";
import { configOf, type AdsDeps } from "./shared";
import { statusEvent } from "./campaigns";

export type TopUpResult =
  | {
      readonly kind: "ok";
      readonly topUp: TopUpRecord;
      readonly quote: TopUpQuote;
      readonly clientAction: "redirect" | "native_sheet" | "none";
      readonly replayed: boolean;
    }
  | { readonly kind: "invalid_amount"; readonly min: bigint; readonly max: bigint }
  | { readonly kind: "psp_unavailable" };

/** Seller B2B top-up. Net is VAT-exclusive; the PSP charges gross (net + 14%). Idempotent per key. */
export class RequestTopUp {
  constructor(private readonly d: AdsDeps) {}

  async execute(i: { readonly storeId: string; readonly net: bigint; readonly idempotencyKey: string }): Promise<TopUpResult> {
    const d = this.d;
    const cfg = await configOf(d);
    if (i.net < cfg.minTopUp || i.net > cfg.maxTopUp) return { kind: "invalid_amount", min: cfg.minTopUp, max: cfg.maxTopUp };
    const quote = quoteTopUp(i.net, cfg.vatBps);
    const nowMs = d.clock.nowMs();
    const rec: TopUpRecord = {
      id: d.ids.uuidV7(),
      storeId: i.storeId,
      net: quote.net,
      vat: quote.vat,
      gross: quote.gross,
      status: "PENDING_PAYMENT",
      intentRef: null,
      idempotencyKey: i.idempotencyKey,
      createdAtMs: nowMs,
      creditedAtMs: null,
    };
    const ins = await d.store.insertTopUp(rec);
    const topUp = ins.topUp;
    if (ins.kind === "duplicate") {
      return { kind: "ok", topUp, quote: { net: topUp.net, vat: topUp.vat, gross: topUp.gross }, clientAction: "none", replayed: true };
    }
    try {
      const intent = await d.charges.create({
        storeId: i.storeId,
        topUpId: topUp.id,
        net: topUp.net,
        vat: topUp.vat,
        gross: topUp.gross,
        idempotencyKey: `ads-topup:${topUp.id}`,
      });
      await d.store.setTopUpIntent(topUp.id, intent.intentRef);
      return { kind: "ok", topUp: { ...topUp, intentRef: intent.intentRef }, quote, clientAction: intent.clientAction, replayed: false };
    } catch {
      await d.store.failTopUp(topUp.id);
      return { kind: "psp_unavailable" };
    }
  }
}

export type ConfirmTopUpResult =
  | { readonly kind: "credited"; readonly balance: bigint; readonly resumed: number }
  | { readonly kind: "replayed"; readonly balance: bigint }
  | { readonly kind: "intent_mismatch" }
  | { readonly kind: "not_found" };

/** PSP success callback. Credits once; re-posts the (idempotent) ledger entry on every replay. */
export class ConfirmTopUp {
  constructor(private readonly d: AdsDeps) {}

  async execute(input: { readonly topUpId: string; readonly intentRef: string }): Promise<ConfirmTopUpResult> {
    const d = this.d;
    const t = await d.store.getTopUp(input.topUpId);
    if (t === null) return { kind: "not_found" };
    if (t.intentRef !== null && t.intentRef !== input.intentRef) return { kind: "intent_mismatch" };
    const psp = d.topUpPsp;
    if (psp === undefined) throw new Error("ads top-up PSP not configured; refusing to post to a default clearing account");
    const nowMs = d.clock.nowMs();
    const events: OutboxDraft[] = [
      {
        type: "ad.balance_topped_up",
        aggregateType: "ad_balance",
        aggregateId: t.storeId,
        payload: { store_id: t.storeId, top_up_id: t.id, net: Number(t.net), vat: Number(t.vat), currency: "EGP" },
      },
    ];
    const r = await d.store.creditTopUp(t.id, nowMs, events);
    if (r.topUp === null) return { kind: "not_found" };
    await d.ledger.post({
      entryKey: `ads-topup:${t.id}`,
      kind: "ads_topup",
      refId: t.id,
      postings: topUpPostings(t.storeId, { net: t.net, vat: t.vat, gross: t.gross }, psp).map((p) => ({
        account: p.account,
        amount: p.amount.amount,
      })),
    });
    if (r.kind === "replayed") return { kind: "replayed", balance: r.balance };
    const cfg = await configOf(d);
    let resumed = 0;
    if (r.balance >= cfg.floorPrice) {
      const blocked = (await d.enforcement.blockedStores([t.storeId])).has(t.storeId);
      if (!blocked) {
        for (const c of await d.store.listStoreCampaignsInStatus(t.storeId, "PAUSED_NO_BALANCE")) {
          const n = await d.store.setStatus(c.id, "PAUSED_NO_BALANCE", "ACTIVE", nowMs, [statusEvent(c, "PAUSED_NO_BALANCE", "ACTIVE", "balance_restored")]);
          if (n !== null) resumed += 1;
        }
      }
    }
    return { kind: "credited", balance: r.balance, resumed };
  }
}

export class FailTopUp {
  constructor(private readonly d: AdsDeps) {}
  async execute(topUpId: string): Promise<void> {
    await this.d.store.failTopUp(topUpId);
  }
}

export class GetBalance {
  constructor(private readonly d: AdsDeps) {}
  async execute(storeId: string): Promise<{ readonly balance: bigint; readonly topUps: readonly TopUpRecord[] }> {
    return { balance: await this.d.store.getBalance(storeId), topUps: await this.d.store.listTopUps(storeId, 20) };
  }
}

export { ACCOUNTS };
