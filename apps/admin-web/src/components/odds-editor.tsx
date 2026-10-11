"use client";
import { useId, useState } from "react";
import { ppmToPercent, validateOdds, type OddsError, type OddsOutcomeInput } from "../view-models/rewards";

export interface OddsEditorLabels {
  readonly id: string; readonly kind: string; readonly percent: string; readonly coins: string; readonly voucher: string;
  readonly kinds: Readonly<Record<"nothing" | "coins" | "voucher", string>>;
  readonly add: string; readonly remove: string; readonly total: string; readonly publish: string; readonly refused: string;
  readonly approvalId: string; readonly approvalHelp: string; readonly game: string;
  readonly errors: Readonly<Record<OddsError, string>>;
}

const blank = (n: number): OddsOutcomeInput => ({ id: `outcome_${n}`, kind: "nothing", percent: "", coins: "", voucher: "" });

/**
 * Odds editor. The same pure validator that the server action uses runs on every keystroke: the publish button
 * stays disabled and the reasons are announced until the disclosed odds add up to exactly 100%.
 */
export function OddsEditor(p: { readonly game: string; readonly action: (f: FormData) => void | Promise<void>; readonly labels: OddsEditorLabels; readonly disabled: boolean }) {
  const [rows, setRows] = useState<readonly OddsOutcomeInput[]>([blank(1), blank(2)]);
  const base = useId();
  const result = validateOdds(rows);
  const L = p.labels;
  const set = (i: number, patch: Partial<OddsOutcomeInput>): void => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <form action={p.action} className="card" aria-labelledby={`${base}-t`}>
      <h3 id={`${base}-t`}>{p.game}</h3>
      <input type="hidden" name="game" value={p.game} />
      <div className="table-wrap"><table>
        <thead><tr><th>{L.id}</th><th>{L.kind}</th><th>{L.percent}</th><th>{L.coins}</th><th>{L.voucher}</th><th /></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}>
            <td><input aria-label={L.id} name="o_id" value={r.id} dir="ltr" onChange={(e) => set(i, { id: e.target.value })} /></td>
            <td><select aria-label={L.kind} name="o_kind" value={r.kind} onChange={(e) => set(i, { kind: e.target.value })}>
              {(["nothing", "coins", "voucher"] as const).map((k) => <option key={k} value={k}>{L.kinds[k]}</option>)}</select></td>
            <td><input aria-label={L.percent} name="o_percent" value={r.percent} inputMode="decimal" dir="ltr" onChange={(e) => set(i, { percent: e.target.value })} /></td>
            <td><input aria-label={L.coins} name="o_coins" value={r.coins} inputMode="numeric" dir="ltr" readOnly={r.kind !== "coins"} onChange={(e) => set(i, { coins: e.target.value })} /></td>
            <td><input aria-label={L.voucher} name="o_voucher" value={r.voucher} dir="ltr" readOnly={r.kind !== "voucher"} onChange={(e) => set(i, { voucher: e.target.value })} /></td>
            <td><button type="button" className="btn ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>{L.remove}</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <div className="row">
        <button type="button" className="btn" onClick={() => setRows([...rows, blank(rows.length + 1)])}>{L.add}</button>
        <strong aria-live="polite">{L.total.replace("{{total}}", ppmToPercent(result.totalPpm))}</strong>
      </div>
      {result.ok ? null : (
        <div role="alert" className="notice error"><p>{L.refused}</p><ul>{result.errors.map((e) => <li key={e}>{L.errors[e]}</li>)}</ul></div>
      )}
      <label htmlFor={`${base}-a`}>{L.approvalId}</label>
      <input id={`${base}-a`} name="approval_id" required dir="ltr" aria-describedby={`${base}-h`} />
      <p id={`${base}-h`} className="muted">{L.approvalHelp}</p>
      <button type="submit" className="btn primary" disabled={!result.ok || p.disabled}>{L.publish}</button>
    </form>
  );
}
