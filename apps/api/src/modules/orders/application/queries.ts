import type {
  GroupPage,
  ListPage,
  OrderGroupRecord,
  OrderRepository,
  OrderScope,
  SellerOrderRecord,
  SellerOrderState,
} from "../domain/ports";

export class GetOrderGroup {
  constructor(private readonly repo: OrderRepository) {}
  /** Null for unknown and for another user's group alike (404, API1). */
  execute(a: { userId: string; groupId: string }): Promise<OrderGroupRecord | null> {
    return this.repo.getGroupForUser(a.groupId, a.userId);
  }
}

export class GetSellerOrder {
  constructor(private readonly repo: OrderRepository) {}
  execute(a: { scope: OrderScope; sellerOrderId: string }): Promise<SellerOrderRecord | null> {
    return this.repo.getSellerOrder(a.sellerOrderId, a.scope);
  }
}

export class ListSellerOrders {
  constructor(private readonly repo: OrderRepository) {}
  execute(a: {
    scope: OrderScope;
    storeIds: readonly string[];
    status?: SellerOrderState;
    after: { createdAtMs: number; id: string } | null;
    limit: number;
  }): Promise<ListPage> {
    return this.repo.listForStores({
      scope: a.scope,
      storeIds: a.storeIds,
      ...(a.status !== undefined ? { status: a.status } : {}),
      after: a.after,
      limit: a.limit,
    });
  }
}

export class ListMyOrders {
  constructor(private readonly repo: OrderRepository) {}
  execute(a: { userId: string; after: { createdAtMs: number; id: string } | null; limit: number }): Promise<GroupPage> {
    return this.repo.listGroupsForUser(a);
  }
}
