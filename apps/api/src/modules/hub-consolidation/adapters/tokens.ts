export const HUB_STORE = Symbol("hub.HubStore");
export const HUB_FLAGS = Symbol("hub.HubFlagsPort");
export const HUB_FACTS = Symbol("hub.ParcelFactsPort");
export const HUB_OUTBOUND = Symbol("hub.OutboundCourierPort");
export const HUB_LEDGER = Symbol("hub.HubLedgerPort");
export const HUB_METRICS = Symbol("hub.HubMetrics");

export const HUB_LEG_RESOLVER = Symbol("hub.OperatorHubResolver");
export const HUB_PARCEL_RESOLVER = Symbol("hub.ParcelResolver");
export const HUB_GROUP_RESOLVER = Symbol("hub.OrderGroupResolver");

export const OPEN_HUB_GROUP = Symbol("hub.OpenHubGroup");
export const EVALUATE_HUB_GROUP = Symbol("hub.EvaluateHubGroup");
export const RECORD_HUB_RECEIPT = Symbol("hub.RecordHubReceipt");
export const DISPATCH_HUB_PARCEL = Symbol("hub.DispatchHubParcel");
export const SWEEP_HUB_GROUPS = Symbol("hub.SweepHubGroups");
export const GET_HUB_TRACKING = Symbol("hub.GetHubTracking");
