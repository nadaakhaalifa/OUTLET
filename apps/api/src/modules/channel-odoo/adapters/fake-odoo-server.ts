import {
  SECRET_API_KEY,
  SECRET_LOGIN,
  type OdooEgressPort,
  type OdooHttpRequest,
  type OdooHttpResponse,
} from "../domain/ports";

/**
 * Hand-authored, labelled fake Odoo (JSON-RPC /jsonrpc, execute_kw) for contract tests. No network,
 * no real credentials. It models only what the adapter uses: common.authenticate, search_read on
 * product.product / stock.quant / product.pricelist.item and read on product.pricelist.
 * It also plays the egress adapter's role: it substitutes the secret from `secrets` into the body
 * placeholders, so tests can prove the placeholder never carried a real value upstream.
 */

export interface FakeProduct {
  id: number;
  default_code: string | false;
  list_price: number;
  write_date: string;
  product_tmpl_id: number;
  active?: boolean;
}
export interface FakeQuant {
  product_id: number;
  quantity: number;
  reserved_quantity: number;
  write_date: string;
  locationId: number;
  /** The location and its ancestors (for child_of). */
  locationPath: number[];
  locationUsage: "internal" | "customer" | "supplier" | "transit";
}
export interface FakePricelistItem {
  pricelist_id: number;
  product_id: number | false;
  product_tmpl_id: number | false;
  fixed_price: number;
  min_quantity: number;
  date_start: string | false;
  date_end: string | false;
  write_date: string;
  compute_price?: "fixed" | "percentage" | "formula";
  applied_on?: string;
}

export interface SeenRequest {
  readonly url: string;
  readonly pinnedAddress: string;
  /** Body exactly as the application sent it (placeholders, never secrets). */
  readonly rawBody: string;
  readonly model: string | null;
  readonly method: string;
}

type Json = unknown;

export class FakeOdooServer implements OdooEgressPort {
  readonly database = "haul_prod";
  readonly uid = 7;
  products: FakeProduct[] = [];
  quants: FakeQuant[] = [];
  pricelists = new Map<number, { currency: string }>();
  items: FakePricelistItem[] = [];
  /** What this Odoo accepts (server-side truth). The vault below may hold something else (wrong key). */
  account = { login: "", apiKey: "" };
  /** tokenRef -> secret fields (the vault). */
  readonly secrets = new Map<string, { login: string; apiKey: string }>();
  readonly seen: SeenRequest[] = [];
  /** Failure injection. */
  mode: "ok" | "http500" | "redirect" | "rpc_error" | "garbage" | "truncated" | "throw" = "ok";
  connectedAddressOverride: string | null = null;
  /** Count of requests that arrived with a wrong key. */
  badAuthCount = 0;

  async postJson(req: OdooHttpRequest): Promise<OdooHttpResponse> {
    const connected = this.connectedAddressOverride ?? req.pinnedAddress;
    const rawModel = (() => {
      try {
        const b = JSON.parse(req.jsonBody) as { params?: { args?: unknown[] } };
        const m = b.params?.args?.[3];
        return typeof m === "string" ? m : null;
      } catch {
        return null;
      }
    })();
    this.seen.push({ url: req.url, pinnedAddress: req.pinnedAddress, rawBody: req.jsonBody, model: rawModel, method: "call" });
    const ok = (body: Json, status = 200): OdooHttpResponse => ({ status, headers: {}, body: JSON.stringify(body), connectedAddress: connected, truncated: false });
    switch (this.mode) {
      case "throw":
        throw new Error("ECONNRESET");
      case "http500":
        return { status: 500, headers: {}, body: "boom", connectedAddress: connected, truncated: false };
      case "redirect":
        return { status: 302, headers: { location: "https://169.254.169.254/jsonrpc" }, body: "", connectedAddress: connected, truncated: false };
      case "garbage":
        return { status: 200, headers: {}, body: "<html>not json</html>", connectedAddress: connected, truncated: false };
      case "truncated":
        return { status: 200, headers: {}, body: "{", connectedAddress: connected, truncated: true };
      case "rpc_error":
        return ok({ jsonrpc: "2.0", id: 1, error: { code: 200, message: "Odoo Server Error", data: { debug: "secret-stack-trace" } } });
      case "ok":
        break;
    }
    const secret = this.secrets.get(req.tokenRef);
    if (secret === undefined) return ok({ jsonrpc: "2.0", id: 1, error: { code: 100, message: "no secret" } });
    const body = req.jsonBody.split(JSON.stringify(SECRET_LOGIN)).join(JSON.stringify(secret.login)).split(JSON.stringify(SECRET_API_KEY)).join(JSON.stringify(secret.apiKey));
    const env = JSON.parse(body) as { params: { service: string; method: string; args: unknown[] } };
    const { service, method, args } = env.params;
    if (service === "common" && method === "authenticate") {
      const [db, login, key] = args as [string, string, string];
      const good = db === this.database && login === this.account.login && key === this.account.apiKey;
      if (!good) this.badAuthCount += 1;
      return ok({ jsonrpc: "2.0", id: 1, result: good ? this.uid : false });
    }
    if (service === "object" && method === "execute_kw") {
      const [db, uid, key, model, m, a, kw] = args as [string, number, string, string, string, unknown[], Record<string, unknown>];
      if (db !== this.database || uid !== this.uid || key !== this.account.apiKey) {
        this.badAuthCount += 1;
        return ok({ jsonrpc: "2.0", id: 1, error: { code: 100, message: "Access Denied" } });
      }
      return ok({ jsonrpc: "2.0", id: 1, result: this.dispatch(model, m, a, kw) });
    }
    return ok({ jsonrpc: "2.0", id: 1, error: { code: 404, message: "unknown service" } });
  }

  private dispatch(model: string, method: string, args: unknown[], kw: Record<string, unknown>): Json {
    const fields = Array.isArray(kw["fields"]) ? (kw["fields"] as string[]) : null;
    const limit = typeof kw["limit"] === "number" ? kw["limit"] : Number.MAX_SAFE_INTEGER;
    const offset = typeof kw["offset"] === "number" ? kw["offset"] : 0;
    const domain = (Array.isArray(args[0]) ? args[0] : []) as unknown[];
    const pick = (row: Record<string, unknown>) => {
      if (fields === null) return row;
      const o: Record<string, unknown> = {};
      for (const f of fields) if (f in row) o[f] = row[f];
      return o;
    };
    const has = (t: unknown[], f: string, op: string) => t[0] === f && t[1] === op;
    if (model === "product.product" && method === "search_read") {
      let rows = this.products.filter((p) => p.active !== false);
      for (const t of domain as unknown[][]) {
        if (has(t, "active", "=")) rows = rows.filter((p) => (p.active !== false) === t[2]);
        if (has(t, "default_code", "!=") && t[2] === false) rows = rows.filter((p) => p.default_code !== false);
      }
      rows = [...rows].sort((a, b) => a.id - b.id).slice(offset, offset + limit);
      return rows.map((p) => pick({ id: p.id, default_code: p.default_code, list_price: p.list_price, write_date: p.write_date, product_tmpl_id: [p.product_tmpl_id, `tmpl ${p.product_tmpl_id}`] }));
    }
    if (model === "stock.quant" && method === "search_read") {
      let rows = this.quants;
      for (const t of domain as unknown[][]) {
        if (has(t, "product_id", "in")) rows = rows.filter((q) => (t[2] as number[]).includes(q.product_id));
        if (has(t, "location_id.usage", "=")) rows = rows.filter((q) => q.locationUsage === t[2]);
        if (has(t, "location_id", "child_of")) rows = rows.filter((q) => q.locationPath.includes(t[2] as number));
      }
      return rows.slice(offset, offset + limit).map((q) => pick({ product_id: [q.product_id, `p ${q.product_id}`], quantity: q.quantity, reserved_quantity: q.reserved_quantity, write_date: q.write_date }));
    }
    if (model === "product.pricelist" && method === "read") {
      const ids = (args[0] as number[]) ?? [];
      return ids.flatMap((id) => {
        const p = this.pricelists.get(id);
        return p === undefined ? [] : [pick({ id, currency_id: [1, p.currency] })];
      });
    }
    if (model === "product.pricelist.item" && method === "search_read") {
      let rows = this.items;
      for (const t of domain as unknown[][]) {
        if (has(t, "pricelist_id", "=")) rows = rows.filter((i) => i.pricelist_id === t[2]);
        if (has(t, "compute_price", "=")) rows = rows.filter((i) => (i.compute_price ?? "fixed") === t[2]);
        if (has(t, "applied_on", "in")) rows = rows.filter((i) => (t[2] as string[]).includes(i.applied_on ?? (i.product_id !== false ? "0_product_variant" : "1_product")));
      }
      return rows.slice(offset, offset + limit).map((i) =>
        pick({
          product_id: i.product_id === false ? false : [i.product_id, `p ${i.product_id}`],
          product_tmpl_id: i.product_tmpl_id === false ? false : [i.product_tmpl_id, `tmpl ${i.product_tmpl_id}`],
          fixed_price: i.fixed_price,
          min_quantity: i.min_quantity,
          date_start: i.date_start,
          date_end: i.date_end,
          write_date: i.write_date,
        }),
      );
    }
    throw new Error(`fake odoo: unsupported ${model}.${method}`);
  }
}
