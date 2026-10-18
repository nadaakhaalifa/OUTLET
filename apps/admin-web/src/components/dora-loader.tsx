"use client";
import { useId, useState } from "react";
import { doraView, parseDora, type DoraView } from "../view-models/dora";

export interface DoraLabels {
  readonly input: string; readonly file: string; readonly load: string; readonly invalid: string; readonly notMeasured: string;
  readonly proxy: string; readonly window: string; readonly basis: string; readonly sample: string; readonly band: string;
  readonly series: string; readonly week: string; readonly deployments: string; readonly failures: string; readonly rework: string; readonly notes: string;
  readonly metricNames: Readonly<Record<string, string>>;
}

/** Parses the DORA report in the browser (Zod). Nothing is uploaded; null metrics render "not measured". */
export function DoraLoader({ labels: L }: { readonly labels: DoraLabels }) {
  const [view, setView] = useState<DoraView | null>(null);
  const [bad, setBad] = useState(false);
  const [text, setText] = useState("");
  const id = useId();
  const load = (t: string): void => {
    const r = parseDora(t);
    setBad(!r.ok);
    setView(r.ok ? doraView(r.report) : null);
  };
  return (
    <div>
      <label htmlFor={`${id}-t`}>{L.input}</label>
      <textarea className="wide" id={`${id}-t`} rows={6} dir="ltr" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <label htmlFor={`${id}-f`}>{L.file}</label>
        <input id={`${id}-f`} type="file" accept="application/json,.json" onChange={(e) => {
          const f = e.target.files?.[0];
          if (f !== undefined) void f.text().then((t) => { setText(t); load(t); });
        }} />
        <button type="button" className="btn primary" onClick={() => load(text)}>{L.load}</button>
      </div>
      {bad ? <p role="alert" className="notice error">{L.invalid}</p> : null}
      {view === null ? null : (
        <section aria-live="polite">
          <p className="muted">{L.window.replace("{{days}}", String(view.windowDays)).replace("{{at}}", view.generatedAt)}</p>
          {view.isProxy ? <p role="note" className="notice">{L.proxy.replace("{{proxy}}", view.proxy)}</p> : null}
          <div className="table-wrap"><table>
            <tbody>{view.metrics.map((m) => (
              <tr key={m.id}>
                <th scope="row">{L.metricNames[m.id] ?? m.id}</th>
                <td><strong>{m.value ?? L.notMeasured}</strong></td>
                <td className="muted">{L.basis.replace("{{basis}}", m.basis)}{m.sample === null ? "" : ` · ${L.sample.replace("{{n}}", m.sample)}`}{m.band === null ? "" : ` · ${L.band.replace("{{band}}", m.band)}`}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <h3>{L.series}</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>{L.week}</th><th>{L.deployments}</th><th>{L.failures}</th><th>{L.rework}</th></tr></thead>
            <tbody>{view.series.map((s) => <tr key={s.weekStart}><td dir="ltr">{s.weekStart}</td><td>{s.deployments}</td><td>{s.failures}</td><td>{s.rework}</td></tr>)}</tbody>
          </table></div>
          {view.notes.length === 0 ? null : <><h3>{L.notes}</h3><ul>{view.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></>}
        </section>
      )}
    </div>
  );
}
