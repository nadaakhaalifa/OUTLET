import type { PaymentMethodId } from "../../domain/seam";

export type PaymobOp =
  | "create_intention"
  | "capture"
  | "void"
  | "refund"
  | "retrieve"
  | "delete_token";

/**
 * What the Paymob port wants sent. `path` and body field names are ASSUMPTIONS about Paymob's API
 * (VERIFY BEFORE LAUNCH, VR-PAY-01). `meta` never goes on the wire: it lets the fixture transport
 * choose a recorded response.
 */
export interface PaymobHttpRequest {
  readonly op: PaymobOp;
  readonly method: "POST" | "GET" | "DELETE";
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>> | null;
  readonly idempotencyKey: string | null;
  readonly meta: { readonly paymentMethod?: PaymentMethodId };
}

export type PaymobTransportOutcome =
  /** An HTTP response was received. */
  | { readonly kind: "response"; readonly status: number; readonly body: unknown }
  /** No response in time: ambiguous, the PSP may have acted. */
  | { readonly kind: "timeout" }
  /** The connection could not be established: the request was definitely not processed. */
  | { readonly kind: "connect_error" };

/**
 * The only seam through which the Paymob port reaches anything. There is deliberately NO HTTP
 * implementation in this repository: Paymob is not contracted, so the only transport that exists
 * is `FixtureTransport`. A production transport is added together with the contract (VR-PAY-01).
 */
export interface PaymobTransport {
  send(req: PaymobHttpRequest): Promise<PaymobTransportOutcome>;
}
