import { cairoDayKey, classifyClick, clickPostings, creditBackPostings, type InvalidReason } from "../domain/bridge";
import type { ClickRecord, OutboxDraft } from "../domain/ports";
import { statusEvent } from "./campaigns";
import { configOf, safeEqual, type AdsDeps } from "./shared";
import { sessionHashOf, signClickToken } from "./selection";

export type ClickResult =
  | { readonly kind: "billed"; readonly clickId: string; readonly productId: string; readonly cost: bigint }
  /** Stored, never billed. The shopper is still sent to the product (a click is never refused to a shopper). */
  | { readonly kind: "not_billed"; readonly productId: string; readonly reason: InvalidReason | "duplicate_token" }
  | { readonly kind: "invalid_token" };

const TOKEN = /^([0-9a-f-]{8,40})\.([0-9a-f-]{36})\.(\d{1,12})\.(\d{10,16})\.([0-9a-f]{40})$/;

/**
 * Click saga: verify the signed token and session binding, classify invalid traffic, then bill
 * atomically against the Cairo-day budget and the prepaid balance. Replay of a token is billed
 * once (UNIQUE jti). The posting to the ledger is idempotent on the click id.
 */
export class RecordClick {
  constructor(private readonly d: AdsDeps) {}

  async execute(input: { readonly token: string; readonly sessionId: string; readonly viewerStoreIds: readonly string[] }): Promise<ClickResult> {
    const d = this.d;
    const m = TOKEN.exec(input.token);
    if (m === null) return { kind: "invalid_token" };
    const [, jti, impressionId, priceRaw, issuedRaw, sig] = m;
    if (jti === undefined || impressionId === undefined || priceRaw === undefined || issuedRaw === undefined || sig === undefined) {
      return { kind: "invalid_token" };
    }
    const imp = await d.store.getImpression(impressionId);
    if (imp === null) return { kind: "invalid_token" };
    const sessionHash = await sessionHashOf(d, input.sessionId);
    if (sessionHash !== imp.sessionHash) return { kind: "invalid_token" };
    const price = BigInt(priceRaw);
    const issuedAtMs = Number(issuedRaw);
    const expected = await signClickToken(d, {
      jti,
      impressionId,
      campaignId: imp.campaignId,
      productId: imp.productId,
      sessionHash,
      price,
      issuedAtMs,
    });
    if (!safeEqual(expected, input.token)) return { kind: "invalid_token" };

    const nowMs = d.clock.nowMs();
    const dayKey = cairoDayKey(nowMs);
    const cfg = await configOf(d);
    const base = {
      id: d.ids.uuidV7(),
      tokenJti: jti,
      campaignId: imp.campaignId,
      storeId: imp.storeId,
      productId: imp.productId,
      impressionId,
      sessionHash,
      dayKey,
      atMs: nowMs,
      postedEntryId: null,
      creditedBack: 0n,
    } as const;
    const reject = async (reason: InvalidReason): Promise<ClickResult> => {
      const r = await d.store.billClick({ ...base, valid: false, invalidReason: reason, cost: 0n }, { dailyBudget: 0n }, []);
      if (r.kind === "duplicate") return { kind: "not_billed", productId: imp.productId, reason: "duplicate_token" };
      return { kind: "not_billed", productId: imp.productId, reason };
    };

    if (!(await d.flags.sponsoredEnabled())) return reject("kill_switch");
    const campaign = await d.store.getCampaign(imp.campaignId);
    if (campaign === null) return { kind: "invalid_token" };

    const signalQuery = {
      sessionHash,
      campaignId: imp.campaignId,
      productId: imp.productId,
      dayKey,
      windowSinceMs: nowMs - cfg.clickDedupeWindowMs,
      minuteSinceMs: nowMs - 60_000,
    };
    const botScoreBp = await d.bots.score(sessionHash);
    const classify = (sig: { validInWindow: number; clicksLastMinute: number; campaignClicksToday: number }) =>
      classifyClick(
        {
          nowMs,
          tokenIssuedAtMs: issuedAtMs,
          impressionAtMs: imp.atMs,
          validInWindow: sig.validInWindow,
          clicksLastMinute: sig.clicksLastMinute,
          campaignClicksToday: sig.campaignClicksToday,
          selfClick: input.viewerStoreIds.includes(imp.storeId),
          botScoreBp,
        },
        cfg,
      );
    // Cheap early exit; the authoritative read is repeated inside the billing transaction (B-8).
    const verdict = classify(await d.store.clickSignals(signalQuery));
    if (!verdict.valid) return reject(verdict.reason);

    const cost = price > campaign.maxCpc ? campaign.maxCpc : price;
    const events: OutboxDraft[] = [
      {
        type: "ad.click_valid",
        aggregateType: "ad_campaign",
        aggregateId: imp.campaignId,
        payload: { campaign_id: imp.campaignId, store_id: imp.storeId, product_id: imp.productId, cost: Number(cost), currency: "EGP" },
      },
    ];
    const r = await d.store.billClick(
      { ...base, valid: true, invalidReason: null, cost },
      { dailyBudget: campaign.dailyBudget },
      events,
      {
        query: signalQuery,
        verdict: (sig) => {
          const v = classify(sig);
          return v.valid ? null : v.reason;
        },
      },
    );
    if (r.kind === "duplicate") return { kind: "not_billed", productId: imp.productId, reason: "duplicate_token" };
    if (r.kind === "rejected") {
      const reason = (r.click.invalidReason ?? "budget_exhausted") as InvalidReason;
      if (reason === "budget_exhausted") {
        await d.store.setStatus(campaign.id, campaign.status, campaign.status, nowMs, [
          { type: "ad.budget_exhausted", aggregateType: "ad_campaign", aggregateId: campaign.id, payload: { campaign_id: campaign.id, day_key: dayKey } },
        ]);
      }
      if (reason === "no_balance") await this.pauseUnfunded(imp.storeId, nowMs);
      return { kind: "not_billed", productId: imp.productId, reason };
    }
    try {
      const posted = await d.ledger.post({
        entryKey: `ads-click:${r.click.id}`,
        kind: "ads_click",
        refId: r.click.id,
        postings: clickPostings(r.click.storeId, cost).map((p) => ({ account: p.account, amount: p.amount.amount })),
      });
      await d.store.markPosted(r.click.id, posted.entryId);
    } catch {
      // The sweeper (PostClickSpend) retries; the click stays unposted and the posting is idempotent.
    }
    if ((await d.store.getBalance(imp.storeId)) < cfg.floorPrice) await this.pauseUnfunded(imp.storeId, nowMs);
    return { kind: "billed", clickId: r.click.id, productId: imp.productId, cost };
  }

  private async pauseUnfunded(storeId: string, nowMs: number): Promise<void> {
    for (const c of await this.d.store.listStoreCampaignsInStatus(storeId, "ACTIVE")) {
      await this.d.store.setStatus(c.id, "ACTIVE", "PAUSED_NO_BALANCE", nowMs, [statusEvent(c, "ACTIVE", "PAUSED_NO_BALANCE", "balance_depleted")]);
    }
  }
}

/** Reconciliation sweeper: clicks that were billed but not yet posted to the ledger. */
export class PostClickSpend {
  constructor(private readonly d: AdsDeps) {}

  async execute(limit = 200): Promise<{ readonly posted: number; readonly failed: number }> {
    let posted = 0;
    let failed = 0;
    for (const c of await this.d.store.listUnposted(limit)) {
      try {
        const e = await this.d.ledger.post({
          entryKey: `ads-click:${c.id}`,
          kind: "ads_click",
          refId: c.id,
          postings: clickPostings(c.storeId, c.cost).map((p) => ({ account: p.account, amount: p.amount.amount })),
        });
        await this.d.store.markPosted(c.id, e.entryId);
        posted += 1;
      } catch {
        failed += 1;
      }
    }
    return { posted, failed };
  }
}

/** Invalid traffic found after billing (bot batch, chargeback of fraud): restores the seller's money. */
export class CreditBackClick {
  constructor(private readonly d: AdsDeps) {}

  async execute(clickId: string): Promise<"credited" | "replayed" | "not_found"> {
    const d = this.d;
    const r = await d.store.creditBack(clickId, d.clock.nowMs());
    if (r.kind !== "credited" || r.click === null) return r.kind === "credited" ? "credited" : r.kind;
    const c: ClickRecord = r.click;
    if (c.postedEntryId !== null) {
      await d.ledger.post({
        entryKey: `ads-click-credit-back:${c.id}`,
        kind: "ads_click_credit_back",
        refId: c.id,
        postings: creditBackPostings(c.storeId, c.cost).map((p) => ({ account: p.account, amount: p.amount.amount })),
      });
    }
    return "credited";
  }
}
