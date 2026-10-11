export const TAX_CONFIG = Symbol("taxEta.TaxConfigRepository");
export const TAX_DOCUMENTS = Symbol("taxEta.TaxDocumentRepository");
export const TAX_ETA_PORT = Symbol("taxEta.EtaPort");
export const TAX_SIGNED_STORE = Symbol("taxEta.SignedDocumentStore");
export const TAX_DELEGATIONS = Symbol("taxEta.SigningDelegationPort");
export const TAX_EVENTS = Symbol("taxEta.EventPublisher");

export const QUOTE_ORDER_TAX = Symbol("taxEta.QuoteOrderTax");
export const ISSUE_DOCUMENT = Symbol("taxEta.IssueDocument");
export const PROCESS_SUBMISSION_QUEUE = Symbol("taxEta.ProcessSubmissionQueue");
export const POLL_SUBMISSION_STATUSES = Symbol("taxEta.PollSubmissionStatuses");
export const RUN_DAILY_RECONCILIATION = Symbol("taxEta.RunDailyReconciliation");
export const CHANGE_EXEMPTION = Symbol("taxEta.ChangeExemption");
export const REQUEUE_DEAD_LETTER = Symbol("taxEta.RequeueDeadLetter");
export const LIST_TAX_CATEGORIES = Symbol("taxEta.ListTaxCategories");
export const LIST_EXEMPTION_AUDIT = Symbol("taxEta.ListExemptionAudit");
export const LIST_ADMIN_DOCUMENTS = Symbol("taxEta.ListAdminDocuments");
export const GET_ADMIN_DOCUMENT = Symbol("taxEta.GetAdminDocument");
export const LIST_SELLER_INVOICES = Symbol("taxEta.ListSellerInvoices");
export const GET_SELLER_INVOICE = Symbol("taxEta.GetSellerInvoice");

export const TAX_STORE_LIST_RESOLVER = Symbol("taxEta.StoreListResolver");
export const TAX_STORE_INVOICE_RESOLVER = Symbol("taxEta.StoreInvoiceResolver");
