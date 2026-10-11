export const WR_QUEUE = Symbol("waitingRoom.QueuePort");
export const WR_GATE = Symbol("waitingRoom.DropGatePort");
export const WR_STORE = Symbol("waitingRoom.AdmissionStore");
export const WR_SECRETS = Symbol("waitingRoom.SecretPort");
export const WR_BOT = Symbol("waitingRoom.BotScorePort");
export const WR_ATTEST = Symbol("waitingRoom.AttestationPort");
export const WR_ENTITLEMENTS = Symbol("waitingRoom.EntitlementPort");
export const WR_SWITCHES = Symbol("waitingRoom.SwitchPort");

export const JOIN_QUEUE = Symbol("waitingRoom.JoinQueue");
export const QUEUE_STATUS = Symbol("waitingRoom.QueueStatus");
export const ADMIT_FROM_QUEUE = Symbol("waitingRoom.AdmitFromQueue");
export const ADMISSION_VERIFIER = Symbol("waitingRoom.AdmissionVerifier");
