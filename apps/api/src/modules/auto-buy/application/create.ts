import { createHash } from "node:crypto";
import { NonNegativeMoneySchema } from "@outlet/validation";
import { z } from "zod";
import {
  AUTO_BUY_LIMITS,
  CURRENT_MANDATE_VERSION,
  MANDATE_LOCALES,
  AUTO_BUY_MODES,
  formatPiastres,
  mandateTemplate,
  renderMandateText,
  validateMandateTerms,
  type AutoBuyMode,
  type MandateLocale,
  type TermsViolation,
} from "../domain/bridge";
import type { MandateRecord } from "../domain/ports";
import type { AutoBuyDeps } from "./shared";

/** A positive price in piastres, capped far below the BIGINT range (10 million EGP). */
const PriceSchema = NonNegativeMoneySchema.refine((m) => m.amount > 0n && m.amount <= 1_000_000_000n, {
  message: "price must be positive and at most 10,000,000 EGP",
});

export const CreateInputSchema = z
  .object({
    sku_id: z.uuid(),
    size_label: z.string().trim().min(1).max(AUTO_BUY_LIMITS.sizeLabelMax),
    target_price: PriceSchema,
    max_price: PriceSchema,
    expires_at: z.iso.datetime({ offset: true }),
    mode: z.enum(AUTO_BUY_MODES).default("notify_confirm"),
    payment_token_ref: z.string().min(8).max(200).optional(),
    locale: z.enum(MANDATE_LOCALES),
    accepted_terms_version: z.number().int().min(1),
  })
  .strict()
  .refine((b) => (b.mode === "unattended") === (b.payment_token_ref !== undefined), {
    path: ["payment_token_ref"],
    message: "payment_token_ref is required for unattended mode and not allowed otherwise",
  });

export interface CreateInput {
  readonly userId: string;
  readonly skuId: string;
  readonly sizeLabel: string;
  readonly targetPrice: bigint;
  readonly maxPrice: bigint;
  readonly expiresAtMs: number;
  readonly mode: AutoBuyMode;
  readonly pspTokenRef: string | null;
  readonly locale: MandateLocale;
  readonly acceptedTermsVersion: number;
  readonly deviceId: string;
}

export type CreateResult =
  | { readonly kind: "created"; readonly mandate: MandateRecord; readonly termsText: string }
  | { readonly kind: "disabled" }
  | { readonly kind: "plus_required" }
  | { readonly kind: "age_restricted" }
  | { readonly kind: "unattended_unavailable" }
  | { readonly kind: "sku_unavailable" }
  | { readonly kind: "drop_sku_excluded" }
  | { readonly kind: "size_invalid" }
  | { readonly kind: "invalid"; readonly violations: readonly TermsViolation[] }
  | { readonly kind: "terms_version_stale"; readonly current: number }
  | { readonly kind: "risk_blocked" }
  | { readonly kind: "token_invalid" }
  | { readonly kind: "limit_reached" }
  | { readonly kind: "duplicate_active" };

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Cairo is UTC+2 or UTC+3; the mandate shows the calendar date in UTC+2 which is never later than Cairo's. */
const dateOf = (ms: number): string => new Date(ms + 2 * 3_600_000).toISOString().slice(0, 10);

/**
 * Creates the explicit per-item opt-in. Everything that can be refused is refused BEFORE a row is
 * written, and no PSP or inventory call is made at creation (the token is only inspected).
 */
export class CreateMandate {
  constructor(private readonly d: AutoBuyDeps) {}

  async execute(i: CreateInput): Promise<CreateResult> {
    const d = this.d;
    if (!(await d.flags.rulesEnabled())) return { kind: "disabled" };
    if (i.mode === "unattended" && !(await d.flags.chargeEnabled())) return { kind: "unattended_unavailable" };

    const el = await d.eligibility.eligibility(i.userId);
    if (!el.plusActive) return { kind: "plus_required" };
    if (!el.ageOk) return { kind: "age_restricted" };

    if (i.acceptedTermsVersion !== CURRENT_MANDATE_VERSION) return { kind: "terms_version_stale", current: CURRENT_MANDATE_VERSION };
    const template = mandateTemplate(CURRENT_MANDATE_VERSION, i.locale);
    if (template === null) return { kind: "terms_version_stale", current: CURRENT_MANDATE_VERSION };

    const quote = await d.catalog.quote(i.skuId, i.sizeLabel);
    if (quote === null || !quote.listed) return { kind: "sku_unavailable" };
    if (quote.dropSku) return { kind: "drop_sku_excluded" };
    if (!quote.sizeKnown) return { kind: "size_invalid" };

    const now = d.clock.nowMs();
    const violations = validateMandateTerms({
      currentPrice: quote.price,
      targetPrice: i.targetPrice,
      maxPrice: i.maxPrice,
      expiresAtMs: i.expiresAtMs,
      nowMs: now,
      sizeLabel: i.sizeLabel,
    });
    if (violations.length > 0) return { kind: "invalid", violations };

    if ((await d.risk.decide({ userId: i.userId, stage: "create", skuId: i.skuId, amount: i.maxPrice })) !== "allow") {
      return { kind: "risk_blocked" };
    }
    if (i.mode === "unattended") {
      if (i.pspTokenRef === null || (await d.vault.inspect(i.userId, i.pspTokenRef)) !== "valid") return { kind: "token_invalid" };
    }

    const termsText = renderMandateText(template, {
      item: i.locale === "ar" ? quote.itemLabelAr : quote.itemLabelEn,
      size: i.sizeLabel,
      target: formatPiastres(i.targetPrice),
      max: formatPiastres(i.maxPrice),
      expires: dateOf(i.expiresAtMs),
    });
    const mandate: MandateRecord = {
      id: d.ids.uuidV7(),
      userId: i.userId,
      skuId: i.skuId,
      sizeLabel: i.sizeLabel,
      targetPrice: i.targetPrice,
      maxPrice: i.maxPrice,
      mode: i.mode,
      pspTokenRef: i.mode === "unattended" ? i.pspTokenRef : null,
      status: "ARMED",
      closedReason: null,
      expiresAtMs: i.expiresAtMs,
      mandateVersion: CURRENT_MANDATE_VERSION,
      mandateLocale: i.locale,
      termsSha256: sha256(termsText),
      acceptedAtMs: now,
      acceptedDeviceId: i.deviceId,
      createdAtMs: now,
      updatedAtMs: now,
    };

    return d.store.run(async (tx): Promise<CreateResult> => {
      const stored = await tx.getText(CURRENT_MANDATE_VERSION, i.locale);
      if (stored === null) {
        await tx.putText({ version: CURRENT_MANDATE_VERSION, locale: i.locale, body: template, bodySha256: sha256(template) });
      } else if (stored.body !== template) {
        // The wording under an accepted version must never change: a new wording is a new version.
        throw new Error(`mandate text ${CURRENT_MANDATE_VERSION}/${i.locale} differs from the stored immutable text`);
      }
      await tx.lockUser(i.userId);
      if ((await tx.countArmed(i.userId)) >= AUTO_BUY_LIMITS.maxActivePerUser) return { kind: "limit_reached" };
      if ((await tx.insertMandate(mandate)) === "duplicate_active") return { kind: "duplicate_active" };
      await tx.emit([{ type: "auto_buy.armed", userId: i.userId, mandateId: mandate.id, mode: i.mode }]);
      return { kind: "created", mandate, termsText };
    });
  }
}
