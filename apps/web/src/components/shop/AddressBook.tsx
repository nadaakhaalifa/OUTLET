"use client";
import { useCallback, useEffect, useState } from "react";
import type { Locale } from "@outlet/i18n";
import { Button } from "@outlet/ui-web";
import { browserApi, type ShopperApi } from "../../lib/client-api";
import type { Address } from "../../lib/wire";
import { AddressForm } from "./AddressForm";
import { Alert, isProblem, Status, useShared } from "./shared";

type Mode = { readonly kind: "list" } | { readonly kind: "add" } | { readonly kind: "edit"; readonly id: string } | { readonly kind: "delete"; readonly id: string };

/** Address book: list, add, edit, delete (confirm first), make default. Nothing is optimistic; the list is whatever the server last returned. */
export function AddressBook({ locale, api = browserApi() }: { readonly locale: Locale; readonly api?: ShopperApi }) {
  const { t, base } = useShared(locale);
  const [items, setItems] = useState<readonly Address[]>([]);
  const [state, setState] = useState<"loading" | "out" | "error" | "ready">("loading");
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try { setItems(await api.listAddresses()); setState("ready"); } catch (e) { setState(isProblem(e, 401) ? "out" : "error"); }
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);

  async function run(fn: () => Promise<void>, ok: string): Promise<void> {
    setBusy(true); setError(false); setNote(null);
    try { await fn(); await reload(); setNote(ok); setMode({ kind: "list" }); } catch { setError(true); } finally { setBusy(false); }
  }

  if (state === "loading") return <p role="status">{t("orders.list.loading")}</p>;
  if (state === "out") return (
    <div className="empty" role="status">
      <p>{t("auth.required")}</p>
      <a className="shopLink" href={`${base}/login?next=${encodeURIComponent(`${base}/account/addresses`)}`}>{t("auth.goLogin")}</a>
    </div>
  );
  if (state === "error") return <Alert>{t("addresses.loadError")}</Alert>;

  if (mode.kind === "add") return <AddressForm locale={locale} api={api} onSaved={() => { void reload(); setNote(t("addresses.saved")); setMode({ kind: "list" }); }} onCancel={() => { setMode({ kind: "list" }); }} />;
  const editing = mode.kind === "edit" ? items.find((a) => a.id === mode.id) : undefined;
  if (editing !== undefined) return <AddressForm locale={locale} api={api} initial={editing} onSaved={() => { void reload(); setNote(t("addresses.saved")); setMode({ kind: "list" }); }} onCancel={() => { setMode({ kind: "list" }); }} />;

  return (
    <div className="shopStack">
      {note === null ? null : <Status>{note}</Status>}
      {error ? <Alert>{t("addresses.error")}</Alert> : null}
      {items.length === 0 ? <p className="empty">{t("addresses.none")}</p> : (
        <ul className="shopList">
          {items.map((a) => (
            <li key={a.id} className="shopCard">
              <div className="shopListRow">
                <strong>{a.recipient_name}</strong>
                <span className="shopRow">
                  {a.is_default ? <span className="shopChip shopChipGood">{t("addresses.default")}</span> : null}
                  {a.cod_eligible === true ? <span className="shopChip shopChipGood">{t("addresses.cod")}</span> : null}
                </span>
              </div>
              <p>{t("addresses.line", { street: a.fields.street, building: a.fields.building })}</p>
              <p className="hint" dir="ltr">{a.phone_e164}</p>
              {mode.kind === "delete" && mode.id === a.id ? (
                <div role="group" aria-label={t("addresses.deleteConfirm")} className="shopRow">
                  <Button loading={busy} onClick={() => { void run(() => api.deleteAddress(a.id), t("addresses.deleted")); }}>{t("addresses.deleteConfirm")}</Button>
                  <Button variant="ghost" disabled={busy} onClick={() => { setMode({ kind: "list" }); }}>{t("addresses.deleteKeep")}</Button>
                </div>
              ) : (
                <div className="shopRow">
                  <Button variant="secondary" aria-label={t("addresses.editFor", { name: a.recipient_name })} onClick={() => { setMode({ kind: "edit", id: a.id }); }}>{t("addresses.edit")}</Button>
                  {a.is_default ? null : (
                    <Button variant="secondary" disabled={busy} aria-label={t("addresses.makeDefaultFor", { name: a.recipient_name })} onClick={() => {
                      void run(async () => { await api.makeDefaultAddress(a.id); }, t("addresses.saved"));
                    }}>{t("addresses.makeDefault")}</Button>
                  )}
                  <Button variant="ghost" aria-label={t("addresses.deleteFor", { name: a.recipient_name })} onClick={() => { setMode({ kind: "delete", id: a.id }); }}>{t("addresses.delete")}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Button onClick={() => { setMode({ kind: "add" }); }}>{t("addresses.add")}</Button>
    </div>
  );
}
