export const DROP_STORE = Symbol("drops.DropStore");
export const DROP_INVENTORY = Symbol("drops.DropInventoryPort");
export const DROP_FLAGS = Symbol("drops.SoldOutFlagPort");
export const DROP_SIGNALS = Symbol("drops.SocialSignalsPort");
export const DROP_SWITCHES = Symbol("drops.SwitchPort");
export const DROP_VERIFIER = Symbol("drops.AdmissionVerifierPort");

export const DROP_RESOLVER = Symbol("drops.DropResolver");
export const DROP_STORE_LIST_RESOLVER = Symbol("drops.StoreListResolver");
export const DROP_ADMIN_RESOLVER = Symbol("drops.AdminResolver");

export const CREATE_DROP = Symbol("drops.CreateDrop");
export const EDIT_DROP = Symbol("drops.EditDrop");
export const SCHEDULE_DROP = Symbol("drops.ScheduleDrop");
export const REMOVE_DROP = Symbol("drops.RemoveDrop");
export const GET_SELLER_DROP = Symbol("drops.GetSellerDrop");
export const LIST_SELLER_DROPS = Symbol("drops.ListSellerDrops");
export const LIST_PUBLIC_DROPS = Symbol("drops.ListPublicDrops");
export const GET_PUBLIC_DROP = Symbol("drops.GetPublicDrop");
export const ADMIN_CONTROL_DROP = Symbol("drops.AdminControlDrop");
export const JOIN_WAITLIST = Symbol("drops.JoinWaitlist");
export const ADVANCE_DROPS = Symbol("drops.AdvanceDrops");
export const RESERVE_DROP_UNITS = Symbol("drops.ReserveDropUnits");
export const RELEASE_DROP_UNITS = Symbol("drops.ReleaseDropUnits");
export const CLAIM_DROP_UNITS = Symbol("drops.ClaimDropUnits");
export const DROP_GATE = Symbol("drops.DropGate");
export const ADMIN_DROPS_OPS = Symbol("drops.AdminDropsOps");
