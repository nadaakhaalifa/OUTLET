import { z } from "zod";

/**
 * Each app names its token variables differently (Seller `--c-surface`, `--s-md`, `--target`; Admin `--surface`,
 * `--sp-md`, `--tap`). The component stylesheet is generated against whichever naming the host app already emits,
 * so neither app's variables or classes change. Options are validated: they are interpolated into CSS.
 */
const prefix = z.string().regex(/^--[a-z0-9-]*$/);
const name = z.string().regex(/^--[a-z0-9-]+$/);
export const UiWebCssOptions = z.object({ color: prefix, space: prefix, tap: name, radius: prefix.default("--r-") }).strict();
export type UiWebCssOptions = z.input<typeof UiWebCssOptions>;

/** Presets matching the two existing apps. */
export const ADMIN_CSS: UiWebCssOptions = { color: "--", space: "--sp-", tap: "--tap" };
export const SELLER_CSS: UiWebCssOptions = { color: "--c-", space: "--s-", tap: "--target" };

/**
 * Stylesheet for the `uw-*` components. Logical properties only (RTL is the default, LTR mirrors), no colour
 * literals (roles only), reduced motion honoured. Deliver it in a nonce'd <style>, never as style attributes.
 */
export function uiWebCss(input: UiWebCssOptions): string {
  const o = UiWebCssOptions.parse(input);
  const c = (role: string): string => `var(${o.color}${role})`;
  const s = (k: string): string => `var(${o.space}${k})`;
  const r = (k: string): string => `var(${o.radius}${k})`;
  const tap = `var(${o.tap})`;
  return `
[hidden]{display:none!important}
.uw-card{background:${c("surface")};border-radius:${r("lg")};box-shadow:var(--shadow-card);padding:${s("lg")};margin-block:${s("lg")}}
.uw-card>h2,.uw-card>h3{margin:0 0 ${s("sm")};font-size:14px;font-weight:500;color:${c("text-secondary")}}
.uw-muted{color:${c("text-secondary")}}
.uw-sr{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.uw-btn{min-block-size:${tap};min-inline-size:${tap};padding-inline:${s("lg")};border-radius:${r("md")};border:1px solid ${c("text-primary")};background:transparent;color:${c("text-primary")};cursor:pointer;font:inherit;font-size:14px}
.uw-btn:hover{background:${c("fill")}}
.uw-btn[aria-pressed="true"]{background:${c("fill")};font-weight:600}
.uw-btn:focus-visible,.uw-sort:focus-visible,.uw-def>summary:focus-visible{outline:2px solid ${c("brand")};outline-offset:3px}
.uw-badge{display:inline-flex;align-items:center;gap:${s("xs")};padding:2px ${s("md")};border-radius:${r("pill")};font-size:12px;border:1px solid ${c("text-secondary")};background:${c("fill")};color:${c("text-primary")}}
.uw-badge-ok{border-color:${c("savings")};color:${c("savings")};background:transparent}
.uw-badge-warn{border-color:${c("text-primary")};border-style:dashed;background:transparent}
.uw-badge-bad{border-color:${c("danger")};border-width:2px;color:${c("danger")};background:transparent}
.uw-badge-info{border-style:dotted;background:transparent}
.uw-badge-glyph{font-size:11px}
.uw-kpi{display:grid;gap:${s("xs")};min-inline-size:160px;padding:${s("md")} ${s("md")};background:${c("surface")};border-radius:${r("lg")};box-shadow:var(--shadow-card)}
.uw-kpi-label{display:flex;align-items:center;gap:${s("xs")};margin:0;font-size:12px;color:${c("text-secondary")}}
.uw-kpi-value{margin:0;font-size:28px;line-height:34px;font-variant-numeric:tabular-nums;font-weight:500}
.uw-kpi-delta{display:inline-flex;gap:${s("xs")};align-items:center;margin:0;font-size:12px;font-variant-numeric:tabular-nums}
.uw-kpi-delta.uw-good{color:${c("savings")}}.uw-kpi-delta.uw-bad{color:${c("danger")}}
.uw-kpi-asof{margin:0;font-size:11px;color:${c("text-secondary")}}
.uw-kpi[data-state="stale"]{opacity:.8;border:1px dashed ${c("text-secondary")}}
.uw-kpi[data-state="error"]{border:1px solid ${c("danger")}}
.uw-kpi-msg{margin:0;font-size:12px}
.uw-def{display:inline-block}.uw-def>summary{cursor:pointer;list-style:none;min-inline-size:24px;min-block-size:24px;display:inline-flex;align-items:center;justify-content:center;border:1px solid ${c("text-secondary")};border-radius:${r("pill")};font-size:11px}
.uw-def>summary::-webkit-details-marker{display:none}
.uw-def>.uw-def-body{margin:${s("xs")} 0 0;font-size:12px;max-inline-size:36ch;font-weight:400;color:${c("text-primary")}}
.uw-tablewrap{overflow-x:auto}
.uw-table{border-collapse:collapse;inline-size:100%}
.uw-table caption{text-align:start;font-size:14px;padding-block-end:${s("sm")};color:${c("text-secondary")}}
.uw-table th,.uw-table td{text-align:start;padding:${s("sm")} ${s("md")};border-block-end:1px solid ${c("hairline")};vertical-align:top;font-weight:400}
.uw-table th{font-weight:500;font-size:12px;color:${c("text-secondary")};background:${c("surface")}}
.uw-table .uw-num{text-align:end;font-variant-numeric:tabular-nums}
.uw-sort{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;gap:${s("xs")};align-items:center;min-block-size:24px}
.uw-state{padding:${s("lg")};border:1px dashed ${c("border")};border-radius:${r("md")};margin:0}
.uw-state-error{border-color:${c("danger")};border-style:solid}
.uw-skeleton{display:block;background:${c("fill")};border-radius:${r("md")};margin-block:${s("sm")};animation:uw-pulse 1.4s ease-in-out infinite;block-size:16px}
.uw-sk-h1{block-size:36px}.uw-sk-h2{block-size:120px}
.uw-sk-w25{inline-size:25%}.uw-sk-w50{inline-size:50%}.uw-sk-w75{inline-size:75%}.uw-sk-w100{inline-size:100%}
@keyframes uw-pulse{50%{opacity:.5}}
.uw-dialog{border:0;border-radius:${r("xl")};box-shadow:var(--shadow-lift);background:${c("background")};color:${c("text-primary")};padding:${s("xl")};max-inline-size:min(560px,92vw)}
.uw-dialog::backdrop{background:${c("overlay")}}
.uw-dialog-head{display:flex;justify-content:space-between;align-items:center;gap:${s("md")}}
.uw-dialog-head h2{margin:0;font-size:18px}
.uw-figure{margin:0;display:grid;gap:${s("sm")}}
.uw-figure>figcaption{display:grid;gap:${s("xs")}}
.uw-figure-title{font-weight:500;margin:0}.uw-figure-summary{margin:0;font-size:13px;color:${c("text-secondary")}}
.uw-figure-note{margin:0;font-size:11px;color:${c("text-secondary")}}
.uw-figure-toolbar{display:flex;justify-content:flex-end}
.uw-demo{border-style:dashed}
.uw-chart{display:block;max-inline-size:100%;block-size:auto;overflow:visible}
.uw-ch-text{fill:${c("text-primary")};font-size:11px;font-variant-numeric:tabular-nums}
.uw-ch-muted{fill:${c("text-secondary")}}
.uw-ch-axis{stroke:${c("text-secondary")};stroke-width:1;fill:none}
.uw-ch-line{stroke:${c("brand")};stroke-width:2;fill:none;stroke-linejoin:round;stroke-linecap:round}
.uw-ch-dot{fill:${c("brand")}}
.uw-ch-band-1{fill:${c("fill")}}.uw-ch-band-2{fill:${c("border")}}.uw-ch-band-3{fill:${c("hairline")}}
.uw-ch-measure{fill:${c("text-primary")}}
.uw-ch-target{stroke:${c("danger")};stroke-width:3}
.uw-ch-up{fill:${c("savings")}}.uw-ch-down{fill:${c("danger")}}
.uw-ch-total{fill:${c("text-primary")}}
.uw-ch-hatch-line{stroke:${c("background")};stroke-width:2}
.uw-chart:focus-visible{outline:2px solid ${c("brand")};outline-offset:3px}
.uw-ch-s0{fill:${c("brand")}}
.uw-ch-s{stroke:${c("text-primary")};stroke-width:1}
.uw-ch-pat-bg{fill:${c("surface")}}
.uw-ch-pat-fg{stroke:${c("text-primary")};stroke-width:1.5;fill:none}
.uw-ch-pat-dot{fill:${c("text-primary")}}
.uw-ch-frame{fill:none;stroke:${c("text-primary")};stroke-width:1}
.uw-ch-late{stroke:${c("danger")};stroke-width:1.5}
.uw-ch-missing{fill:none;stroke:${c("text-secondary")};stroke-width:1;stroke-dasharray:4 3}
.uw-ch-range{fill:${c("brand")}}
.uw-ch-tick{stroke:${c("text-primary")};stroke-width:3}
.uw-ch-stale{opacity:.6}
@media (forced-colors:active){
.uw-ch-s0,.uw-ch-range,.uw-ch-measure,.uw-ch-up,.uw-ch-total,.uw-ch-dot,.uw-ch-pat-dot{fill:CanvasText;forced-color-adjust:none}
.uw-ch-down,.uw-ch-muted{fill:GrayText;forced-color-adjust:none}
.uw-ch-pat-bg,.uw-ch-band-1,.uw-ch-band-2,.uw-ch-band-3{fill:Canvas;forced-color-adjust:none}
.uw-ch-band-1,.uw-ch-band-2,.uw-ch-band-3{stroke:GrayText;stroke-width:1}
.uw-ch-hatch-line{stroke:Canvas;forced-color-adjust:none}
.uw-ch-s,.uw-ch-frame,.uw-ch-late,.uw-ch-pat-fg,.uw-ch-axis,.uw-ch-line,.uw-ch-tick,.uw-ch-target{stroke:CanvasText;forced-color-adjust:none}
.uw-ch-missing{stroke:GrayText;forced-color-adjust:none}
.uw-ch-text{fill:CanvasText;forced-color-adjust:none}
.uw-ch-muted.uw-ch-text{fill:GrayText}
.uw-chart:focus-visible{outline-color:Highlight}
.uw-ch-stale{opacity:1}
.uw-kpi{border:1px solid CanvasText;forced-color-adjust:none}
.uw-kpi[data-state="stale"]{border:1px dashed GrayText;opacity:1}
.uw-kpi[data-state="error"]{border:2px solid Highlight}
}
@media (prefers-reduced-motion:reduce){.uw-skeleton{animation:none}}
`.trim();
}
