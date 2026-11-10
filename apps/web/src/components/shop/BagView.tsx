"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "@outlet/i18n";
import { Button, FreeDeliveryProgress } from "@outlet/ui-web";
import { browserApi, type ShopperApi } from "../../lib/client-api";
import type { Cart, CartGroup, CartLine, ProductBrief } from "../../lib/wire";
import { Alert, isProblem, pickName, useShared, type Shared } from "./shared";

export const MIN_QTY = 1;
/** Contract cap per SKU (CartLinePatch.qty max). */
export const MAX_QTY = 10;

type Load = "loading" | "out" | "error" | "ready";
export interface BagViewProps {
  readonly locale: Locale;
  readonly api?: ShopperApi;
}

/** Optimistic qty only: lines keep their server prices and every total stays the server's until the response replaces the cart. */
function withQty(cart: Cart, lineId: string, qty: number): Cart {
  return { ...cart, groups: cart.groups.map((g) => ({ ...g, lines: g.lines.map((l) => (l.id === lineId ? { ...l, qty } : l)) })) };
}

export function BagView({ locale, api = browserApi() }: BagViewProps) {
  const sh = useShared(locale);
  const { t, base } = sh;
  const [load, setLoad] = useState<Load>("loading");
  const [cart, setCart] = useState<Cart | null>(null);
  const [briefs, setBriefs] = useState<ReadonlyMap<string, ProductBrief | null>>(new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    api.getCart().then((c) => { if (live) { setCart(c); setLoad("ready"); } }, (e: unknown) => { if (live) setLoad(isProblem(e, 401) ? "out" : "error"); });
    return () => { live = false; };
  }, [api]);

  useEffect(() => {
    if (cart === null) return;
    const ids = [...new Set(cart.groups.flatMap((g) => g.lines.map((l) => l.product_id)))].filter((id) => !requested.current.has(id));
    for (const id of ids) {
      requested.current.add(id);
      api.getProductBrief(id).then((b) => { setBriefs((m) => new Map(m).set(id, b)); }, () => { setBriefs((m) => new Map(m).set(id, null)); });
    }
  }, [api, cart]);

  const mark = (id: string, on: boolean): void => { setPending((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; }); };

  const changeQty = useCallback(async (line: CartLine, qty: number): Promise<void> => {
    if (cart === null || qty < MIN_QTY || qty > MAX_QTY || qty === line.qty) return;
    const snapshot = cart;
    setError(null);
    mark(line.id, true);
    setCart(withQty(snapshot, line.id, qty));
    try {
      setCart(await api.setQty(line.id, qty));
    } catch (e) {
      setCart(snapshot);
      if (isProblem(e, 401)) setLoad("out"); else setError(t("bag.error.update"));
    } finally { mark(line.id, false); }
  }, [api, cart, t]);

  const remove = useCallback(async (line: CartLine): Promise<void> => {
    setError(null);
    mark(line.id, true);
    try { setCart(await api.removeLine(line.id)); } catch (e) { if (isProblem(e, 401)) setLoad("out"); else setError(t("bag.error.remove")); } finally { mark(line.id, false); }
  }, [api, t]);

  const ack = useCallback(async (line: CartLine): Promise<void> => {
    if (line.defect_card_id === null || line.defect_card_version === null) return;
    mark(line.id, true);
    try { setCart(await api.ackDefects(line.id, { defectCardId: line.defect_card_id, version: line.defect_card_version, defectCount: line.defect_ack_count ?? 0 })); } catch { setError(t("error.generic")); } finally { mark(line.id, false); }
  }, [api, t]);

  if (load === "loading") return <p role="status">{t("bag.loading")}</p>;
  if (load === "out") return (
    <div className="empty" role="status">
      <p>{t("auth.required")}</p>
      <a className="shopLink" href={`${base}/login?next=${encodeURIComponent(`${base}/bag`)}`}>{t("auth.goLogin")}</a>
    </div>
  );
  if (load === "error" || cart === null) return <Alert>{t("bag.error.load")}</Alert>;

  const groups = cart.groups.map((g) => ({ ...g, lines: g.lines.filter((l) => !l.saved_for_later) })).filter((g) => g.lines.length > 0);
  if (groups.length === 0) return (
    <div className="empty" role="status">
      <p>{t("bag.empty")}</p>
      <p className="hint">{t("bag.emptyHint")}</p>
    </div>
  );
  const suspended = new Set(cart.notices.filter((n) => n.code === "store_suspended" && n.line_id !== null).map((n) => n.line_id));
  const buyable = groups.some((g) => g.lines.some((l) => l.available && !suspended.has(l.id)));

  return (
    <div className="shopStack">
      {cart.notices.some((n) => n.code === "threshold_changed") ? <p role="status" className="shopStatus">{t("bag.notice.threshold")}</p> : null}
      {cart.notices.some((n) => n.code === "defect_card_changed") ? <p role="status" className="shopStatus">{t("bag.notice.defect")}</p> : null}
      {error === null ? null : <Alert>{error}</Alert>}
      {groups.map((g) => (
        <StoreGroup key={g.store_id} group={g} sh={sh} locale={locale} briefs={briefs} pending={pending} suspended={suspended} onQty={(l, q) => { void changeQty(l, q); }} onRemove={(l) => { void remove(l); }} onAck={(l) => { void ack(l); }} />
      ))}
      <section className="shopCard" aria-label={t("bag.subtotal")}>
        <p className="shopTotal"><span>{t("bag.itemsSubtotal")}</span><strong>{sh.money(cart.items_subtotal)}</strong></p>
        <p className="hint">{t("bag.shippingNote")}</p>
        {buyable ? <a className="shopButton" href={`${base}/checkout`}>{t("bag.proceed")}</a> : null}
      </section>
    </div>
  );
}

interface GroupProps {
  readonly group: CartGroup;
  readonly sh: Shared;
  readonly locale: Locale;
  readonly briefs: ReadonlyMap<string, ProductBrief | null>;
  readonly pending: ReadonlySet<string>;
  readonly suspended: ReadonlySet<string | null>;
  readonly onQty: (l: CartLine, q: number) => void;
  readonly onRemove: (l: CartLine) => void;
  readonly onAck: (l: CartLine) => void;
}
function StoreGroup({ group, sh, locale, briefs, pending, suspended, onQty, onRemove, onAck }: GroupProps) {
  const { t, money, base } = sh;
  const headingId = `bag-store-${group.store_id}`;
  return (
    <section className="shopCard" aria-labelledby={headingId}>
      <h2 id={headingId}><a href={`${base}/stores/${group.store_slug}`}>{group.display_name_ar}</a></h2>
      <FreeDeliveryProgress subtotal={group.subtotal} threshold={group.free_delivery_threshold} storeName={group.display_name_ar} locale={locale} />
      <ul className="shopList">
        {group.lines.map((l) => {
          const brief = briefs.get(l.product_id);
          const name = brief ? pickName(locale, brief.title_ar, brief.title_en) : t("bag.line.fallbackName");
          const size = brief?.skus.find((k) => k.sku_id === l.sku_id)?.size_label ?? null;
          const locked = suspended.has(l.id);
          const blocked = locked || !l.available;
          const now = l.current_price.current_price;
          const dropped = now.amountMinor < l.price_at_add.amountMinor;
          const rose = now.amountMinor > l.price_at_add.amountMinor;
          const busy = pending.has(l.id);
          return (
            <li key={l.id} className="shopLine" aria-busy={busy || undefined}>
              <div>
                <p className="shopLineName">{name}</p>
                {size === null ? null : <p className="hint">{t("bag.line.size", { size })}</p>}
                <p className="hint">{t("bag.line.unit", { price: money(now) })}</p>
                {blocked ? <p role="status" className="shopChip shopChipWarn">{locked ? t("bag.storeLocked") : t("bag.unavailable")}</p> : null}
                {!blocked && dropped ? <p className="shopChip shopChipGood">{t("bag.price.dropped", { was: money(l.price_at_add) })}</p> : null}
                {!blocked && rose ? <p className="shopChip shopChipWarn">{t("bag.price.rose", { was: money(l.price_at_add) })}</p> : null}
                {!blocked && l.defect_ack_required && l.defect_ack_at === null ? (
                  <Button variant="secondary" disabled={busy} onClick={() => { onAck(l); }}>{t("bag.defect.ack", { count: l.defect_ack_count ?? 0 })}</Button>
                ) : null}
              </div>
              {blocked ? null : (
                <div className="shopStepper" role="group" aria-label={t("bag.qty.label")}>
                  <Button variant="secondary" aria-label={t("bag.qty.dec", { name })} disabled={busy || l.qty <= MIN_QTY} onClick={() => { onQty(l, l.qty - 1); }}>−</Button>
                  <output aria-live="polite">{t("bag.qty.value", { qty: l.qty })}</output>
                  <Button variant="secondary" aria-label={t("bag.qty.inc", { name })} disabled={busy || l.qty >= MAX_QTY} onClick={() => { onQty(l, l.qty + 1); }}>+</Button>
                </div>
              )}
              <Button variant="ghost" aria-label={t("bag.line.remove", { name })} disabled={busy} onClick={() => { onRemove(l); }}>{t("bag.remove")}</Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
