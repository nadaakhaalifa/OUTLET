import { colors, radius, spacing, typography, minTouchTarget } from "@outlet/ui-tokens";

const vars = (s: "light" | "dark"): string =>
  Object.entries(colors[s]).map(([k, v]) => `--${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${v};`).join("");

/** Token-driven stylesheet, logical properties only so RTL is the default and LTR mirrors for free. */
export const STYLES = `
:root{${vars("light")}--sp-xs:${spacing.xs}px;--sp-sm:${spacing.sm}px;--sp-md:${spacing.md}px;--sp-lg:${spacing.lg}px;--sp-xl:${spacing.xl}px;--r-sm:${radius.sm}px;--r-md:${radius.md}px;--tap:${minTouchTarget}px;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{${vars("dark")}}}
*{box-sizing:border-box}
body{margin:0;background:var(--background);color:var(--text-primary);font:${typography.body.fontSize}px/${typography.body.lineHeight}px "IBM Plex Sans Arabic",system-ui,sans-serif}
a{color:var(--accent)}
.skip{position:absolute;inset-inline-start:-9999px}.skip:focus{inset-inline-start:var(--sp-md);top:var(--sp-md);background:var(--surface);padding:var(--sp-sm);z-index:10}
.shell{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
@media (max-width:800px){.shell{grid-template-columns:1fr}}
.side{background:var(--surface);border-inline-end:1px solid var(--border);padding:var(--sp-lg)}
.side h2{font-size:${typography.heading.fontSize}px;margin:0 0 var(--sp-md)}
.side ul{list-style:none;margin:0;padding:0;display:grid;gap:var(--sp-xs)}
.side a{display:flex;align-items:center;min-block-size:var(--tap);padding-inline:var(--sp-md);border-radius:var(--r-sm);text-decoration:none;color:var(--text-primary)}
.side a:hover,.side a:focus-visible{background:var(--border)}
main{padding:var(--sp-xl);max-inline-size:1200px;inline-size:100%}
.page-header h1{font-size:${typography.title.fontSize}px;line-height:${typography.title.lineHeight}px;margin:0 0 var(--sp-xs)}
.muted{color:var(--text-secondary)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-lg);margin-block:var(--sp-lg)}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;inline-size:100%}
th,td{text-align:start;padding:var(--sp-sm) var(--sp-md);border-block-end:1px solid var(--border);vertical-align:top}
th{color:var(--text-secondary);font-weight:600;font-size:${typography.caption.fontSize}px}
.btn{min-block-size:var(--tap);padding-inline:var(--sp-lg);border-radius:var(--r-sm);border:1px solid var(--border);background:var(--surface);color:var(--text-primary);cursor:pointer;font:inherit}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.btn.danger{background:var(--danger);color:var(--on-danger);border-color:var(--danger)}
.btn.ghost{background:transparent}
.btn:focus-visible,select:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.row{display:flex;gap:var(--sp-sm);flex-wrap:wrap;align-items:center}.row.end{justify-content:flex-end;margin-block-start:var(--sp-lg)}
.notice{padding:var(--sp-md);border-radius:var(--r-sm);border:1px solid var(--border)}
.notice.error{border-color:var(--danger)}.notice.ok{border-color:var(--accent)}
.badge{display:inline-block;padding:2px var(--sp-sm);border-radius:999px;font-size:${typography.caption.fontSize}px;border:1px solid var(--border)}
.badge.bad{border-color:var(--danger);color:var(--danger)}.badge.ok{border-color:var(--accent);color:var(--accent)}.badge.warn{border-style:dashed}
.dialog{border:1px solid var(--border);border-radius:var(--r-md);background:var(--background);color:var(--text-primary);padding:var(--sp-xl);max-inline-size:min(520px,92vw)}
.dialog::backdrop{background:rgba(0,0,0,.5)}
.dialog label{display:block;margin-block:var(--sp-md) var(--sp-xs)}
.dialog select,.dialog input:not([type=checkbox]){inline-size:100%;min-block-size:var(--tap);padding-inline:var(--sp-sm)}
.check{display:flex;gap:var(--sp-sm);align-items:center;min-block-size:var(--tap)}
.kv{display:flex;gap:var(--sp-md);padding-block:var(--sp-xs)}.kv dt{color:var(--text-secondary);min-inline-size:140px}.kv dd{margin:0}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-md);margin-block-end:var(--sp-lg);flex-wrap:wrap}
.meter{display:block;inline-size:120px;block-size:8px;border-radius:4px;background:var(--border);overflow:hidden}
.meter>span{display:block;block-size:100%;background:var(--accent)}.meter.late>span{background:var(--danger)}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;
