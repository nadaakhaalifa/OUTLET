import type { FlagWire } from "../api/schemas";
import type { MessageKey } from "../i18n";

/** The kill switches named in spec A2.12. A test pins this list to packages/feature-flags. */
export const EXPECTED_KILL_SWITCHES = [
  "kill.payment.card",
  "kill.payment.apple_pay",
  "kill.payment.mobile_wallet",
  "kill.payment.instapay",
  "kill.payment.fawry",
  "kill.payment.cod",
  "kill.payment.bnpl",
  "kill.drops",
  "kill.games",
  "kill.stylist_llm",
  "kill.ml_ranking",
  "kill.crawlers",
  "kill.referral_payouts",
  "kill.gift_card_sales",
] as const;

export interface SwitchRow {
  readonly key: string;
  readonly labelKey: MessageKey | null;
  readonly description: string;
  /** true = the capability is ALLOWED to run. Switches are default-off and fail closed. */
  readonly running: boolean;
  readonly isDefault: boolean;
  /** The value a change would set. */
  readonly nextEnabled: boolean;
  readonly reported: boolean;
}

const LABELS: Readonly<Record<string, MessageKey>> = {
  "kill.payment.card": "kill.payment.card",
  "kill.payment.apple_pay": "kill.payment.apple_pay",
  "kill.payment.mobile_wallet": "kill.payment.mobile_wallet",
  "kill.payment.instapay": "kill.payment.instapay",
  "kill.payment.fawry": "kill.payment.fawry",
  "kill.payment.cod": "kill.payment.cod",
  "kill.payment.bnpl": "kill.payment.bnpl",
  "kill.drops": "kill.drops",
  "kill.games": "kill.games",
  "kill.stylist_llm": "kill.stylist_llm",
  "kill.ml_ranking": "kill.ml_ranking",
  "kill.crawlers": "kill.crawlers",
  "kill.referral_payouts": "kill.referral_payouts",
  "kill.gift_card_sales": "kill.gift_card_sales",
};

export interface FlagBoard {
  readonly switches: readonly SwitchRow[];
  /** Expected switches the API did not report: shown as "not reported", never silently dropped. */
  readonly missing: readonly string[];
  readonly releaseFlags: readonly SwitchRow[];
  readonly stoppedCount: number;
}

const toRow = (f: FlagWire): SwitchRow => ({
  key: f.key,
  labelKey: LABELS[f.key] ?? null,
  description: f.description,
  running: f.enabled,
  isDefault: f.is_default,
  nextEnabled: !f.enabled,
  reported: true,
});

export function flagBoard(items: readonly FlagWire[]): FlagBoard {
  const byKey = new Map(items.map((i) => [i.key, i] as const));
  const switches: SwitchRow[] = [];
  const missing: string[] = [];
  for (const key of EXPECTED_KILL_SWITCHES) {
    const f = byKey.get(key);
    if (f === undefined || f.kind !== "kill_switch") missing.push(key);
    else switches.push(toRow(f));
  }
  // Switches the API reports that this UI does not know yet are still listed (appended), not hidden.
  for (const f of items) {
    if (f.kind === "kill_switch" && !(EXPECTED_KILL_SWITCHES as readonly string[]).includes(f.key)) switches.push(toRow(f));
  }
  return {
    switches,
    missing,
    releaseFlags: items.filter((i) => i.kind === "release").map(toRow),
    stoppedCount: switches.filter((s) => !s.running).length,
  };
}
