export const AUTO_BUY_STORE = Symbol("autoBuy.AutoBuyStore");
export const AUTO_BUY_FLAGS = Symbol("autoBuy.AutoBuyFlagsPort");
export const AUTO_BUY_ELIGIBILITY = Symbol("autoBuy.MemberEligibilityPort");
export const AUTO_BUY_CATALOG = Symbol("autoBuy.CatalogQuotePort");
export const AUTO_BUY_DELIVERABILITY = Symbol("autoBuy.DeliverabilityPort");
export const AUTO_BUY_RISK = Symbol("autoBuy.RiskPort");
export const AUTO_BUY_BUDGET = Symbol("autoBuy.BudgetGatePort");
export const AUTO_BUY_VAULT = Symbol("autoBuy.CardVaultPort");
export const AUTO_BUY_INVENTORY = Symbol("autoBuy.InventoryHoldPort");
export const AUTO_BUY_MIT = Symbol("autoBuy.MitCheckoutPort");
export const AUTO_BUY_NOTICES = Symbol("autoBuy.NoticePort");

export const CREATE_AUTO_BUY = Symbol("autoBuy.CreateMandate");
export const LIST_AUTO_BUY = Symbol("autoBuy.ListMandates");
export const CANCEL_AUTO_BUY = Symbol("autoBuy.CancelMandate");
export const CANCEL_AUTO_BUY_ATTEMPT = Symbol("autoBuy.CancelAttempt");
export const HANDLE_PRICE_CHANGE = Symbol("autoBuy.HandlePriceChange");
export const RUN_AUTO_BUY_SWEEP = Symbol("autoBuy.RunSweep");
export const CLOSE_ON_PURCHASE = Symbol("autoBuy.CloseOnPurchase");
export const CANCEL_ALL_AUTO_BUY = Symbol("autoBuy.CancelAllForUser");
export const AUTO_BUY_EVENT_CONSUMER = Symbol("autoBuy.EventConsumer");

export const MANUAL_REVIEW_QUEUE = Symbol("autoBuy.ManualReviewQueue");
export const AUTO_BUY_OPS_AUDIT = Symbol("autoBuy.OpsAuditPort");
