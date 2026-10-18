import { colors, radius, spacing, typography, minTouchTarget } from "@outlet/ui-tokens";
import { ADMIN_CSS, colorVars, motionVars, shadowVars, uiWebCss } from "@outlet/ui-web/css";
import { METER_CSS } from "../view-models/meter";

const vars = (s: "light" | "dark"): string => colorVars(colors[s], "--");
const shadowVarsFor = (dark: boolean): string => shadowVars(dark ? "dark" : "light");

/** Token-driven stylesheet, logical properties only so RTL is the default and LTR mirrors for free. */
export const STYLES = `
:root{${vars("light")}${shadowVarsFor(false)}--sp-xs:${spacing.xs}px;--sp-sm:${spacing.sm}px;--sp-md:${spacing.md}px;--sp-lg:${spacing.lg}px;--sp-xl:${spacing.xl}px;--sp-xxl:${spacing.xxl}px;--sp-xxxl:${spacing.xxxl}px;--r-sm:${radius.sm}px;--r-md:${radius.md}px;--r-lg:${radius.lg}px;--r-xl:${radius.xl}px;--r-pill:${radius.pill}px;--tap:${minTouchTarget}px;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{${vars("dark")}${shadowVarsFor(true)}}}
@font-face{font-family:"Inter";font-weight:400;font-style:normal;font-display:swap;src:url("/fonts/Inter_400Regular.ttf") format("truetype")}
@font-face{font-family:"Inter";font-weight:500;font-style:normal;font-display:swap;src:url("/fonts/Inter_500Medium.ttf") format("truetype")}
@font-face{font-family:"Inter";font-weight:600;font-style:normal;font-display:swap;src:url("/fonts/Inter_600SemiBold.ttf") format("truetype")}
@font-face{font-family:"Plex Sans Arabic";font-weight:300;font-display:swap;src:url("/fonts/IBMPlexSansArabic_300Light.ttf") format("truetype")}
@font-face{font-family:"Plex Sans Arabic";font-weight:400;font-display:swap;src:url("/fonts/IBMPlexSansArabic_400Regular.ttf") format("truetype")}
@font-face{font-family:"Plex Sans Arabic";font-weight:500;font-display:swap;src:url("/fonts/IBMPlexSansArabic_500Medium.ttf") format("truetype")}
@font-face{font-family:"Playfair Display";font-weight:400;font-style:normal;font-display:swap;src:url("/fonts/PlayfairDisplay_400Regular.ttf") format("truetype")}
@font-face{font-family:"Playfair Display";font-weight:400;font-style:italic;font-display:swap;src:url("/fonts/PlayfairDisplay_400Regular_Italic.ttf") format("truetype")}
@font-face{font-family:"Playfair Display";font-weight:500;font-style:normal;font-display:swap;src:url("/fonts/PlayfairDisplay_500Medium.ttf") format("truetype")}
@font-face{font-family:"Playfair Display";font-weight:600;font-style:normal;font-display:swap;src:url("/fonts/PlayfairDisplay_600SemiBold.ttf") format("truetype")}
@font-face{font-family:Amiri;font-weight:400;font-style:normal;font-display:swap;src:url("/fonts/Amiri_400Regular.ttf") format("truetype")}
@font-face{font-family:Amiri;font-weight:700;font-style:normal;font-display:swap;src:url("/fonts/Amiri_700Bold.ttf") format("truetype")}
:root{${motionVars()}--eyebrow-track:.2em;--font-display:"Playfair Display",Amiri,"Times New Roman",Georgia,serif}
:lang(ar){--font-display:Amiri,"Playfair Display","Times New Roman",serif}
*{box-sizing:border-box}
:lang(ar){letter-spacing:0!important;text-transform:none!important}
html{font-family:"Inter","Plex Sans Arabic",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
body{margin:0;background:var(--background);color:var(--text-primary);font-size:${typography.body.fontSize}px;line-height:${typography.body.lineHeight}px;font-weight:400}
a{color:inherit;text-underline-offset:4px;text-decoration-thickness:1px;transition:opacity var(--d2) var(--ease)}
h1,h2,h3{font-weight:400}
:focus-visible{outline:2px solid var(--brand);outline-offset:3px;box-shadow:0 0 0 5px var(--background)}
.skip{position:absolute;inset-inline-start:-9999px}.skip:focus{inset-inline-start:var(--sp-md);top:var(--sp-md);background:var(--surface);padding:var(--sp-sm);z-index:10}
html,body{overflow-x:clip}
.shell{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
@media (max-width:800px){.shell{grid-template-columns:minmax(0,1fr)}}
.side{position:sticky;inset-block-start:0;align-self:start;block-size:100vh;overflow-y:auto;background:var(--background);border-inline-end:1px solid var(--hairline);padding:var(--sp-xl) var(--sp-lg)}
.brandline{margin:0 0 var(--sp-xl);padding:0 var(--sp-sm) var(--sp-lg);border-block-end:1px solid var(--hairline);display:grid;gap:var(--sp-sm);justify-items:start}
.wm{display:block;overflow:visible;color:inherit}
.wm-accent{stroke:var(--brand)}
.wm-eyelet{fill:var(--brand)}
.eyebrow{font-size:${typography.eyebrow.fontSize}px;line-height:${typography.eyebrow.lineHeight}px;font-weight:500;letter-spacing:var(--eyebrow-track);color:var(--text-secondary)}
.login-mark{margin:0 0 var(--sp-lg)}
.login-mark .wm{margin-inline-start:-9px}
.side ul{list-style:none;margin:0;padding:0;display:grid;gap:0}
.side a{position:relative;display:flex;border-radius:var(--r-md);align-items:center;min-block-size:var(--tap);padding-inline:var(--sp-sm);font-size:13px;text-decoration:none;color:var(--text-secondary);transition:color var(--d2) var(--ease)}
.side a:hover,.side a:focus-visible{color:var(--text-primary)}
.side a[aria-current="page"]{color:var(--text-primary);font-weight:500}
.side a[aria-current="page"]{background:var(--brand-soft);border-radius:var(--r-md)}
@media (max-width:800px){.side{position:sticky;block-size:auto;overflow-x:clip;overflow-y:visible;min-inline-size:0;z-index:5;padding:var(--sp-sm) var(--sp-lg);border-inline-end:0;border-block-end:1px solid var(--glass-border);background:var(--glass-tint);-webkit-backdrop-filter:saturate(1.4) blur(18px);backdrop-filter:saturate(1.4) blur(18px)}.side h2{margin:0;padding:var(--sp-sm) 0}.side ul{display:flex;overflow-x:auto;gap:var(--sp-md);scrollbar-width:none}.side li{flex:none}.side a{padding-inline:0;white-space:nowrap}.side a[aria-current="page"]::before{display:none}main{padding:var(--sp-xl) var(--sp-lg)!important}}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.side{background:var(--glass-solid)}}
@media (prefers-reduced-transparency:reduce){.side{background:var(--glass-solid);-webkit-backdrop-filter:none;backdrop-filter:none}}
main{padding:var(--sp-xxl) var(--sp-xxl) 64px;max-inline-size:1200px;inline-size:100%;animation:enter var(--d3) var(--ease) both}
@keyframes enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.topbar{position:sticky;inset-block-start:0;z-index:4;padding-block:var(--sp-sm);margin-inline:calc(var(--sp-xxl)*-1);padding-inline:var(--sp-xxl);background:var(--glass-tint);border-block-end:1px solid var(--glass-border);-webkit-backdrop-filter:saturate(1.4) blur(18px);backdrop-filter:saturate(1.4) blur(18px)}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.topbar{background:var(--glass-solid)}}
@media (prefers-reduced-transparency:reduce){.topbar{background:var(--glass-solid);-webkit-backdrop-filter:none;backdrop-filter:none}}
@media (max-width:800px){.topbar{margin-inline:calc(var(--sp-lg)*-1);padding-inline:var(--sp-lg);inset-block-start:0}}
h1,.page-header h1{font-family:var(--font-display);font-size:${typography.display.fontSize}px;line-height:${typography.display.lineHeight}px;letter-spacing:-.01em;margin:0 0 var(--sp-xs)}
h2{font-size:12px;font-weight:500;color:var(--text-secondary)}
.muted{color:var(--text-secondary)}
.card{background:var(--surface);border-radius:var(--r-lg);box-shadow:var(--shadow-card);padding:var(--sp-lg);margin-block:var(--sp-lg)}
.table-wrap{overflow-x:auto;position:relative}
main{min-width:0}
table{border-collapse:collapse;inline-size:100%}
th,td{text-align:start;padding:var(--sp-md) var(--sp-md);padding-inline:0 var(--sp-md);border-block-end:1px solid var(--hairline);vertical-align:top;font-weight:400}
th{color:var(--text-secondary);font-weight:500;font-size:12px;text-transform:uppercase}
th,td{overflow-wrap:anywhere}
tbody tr{transition:background-color var(--d2) var(--ease)}tbody tr:hover{background:var(--fill)}
.btn{min-block-size:var(--tap);padding-inline:var(--sp-xl);border-radius:var(--r-md);border:1px solid var(--text-primary);background:transparent;color:var(--text-primary);cursor:pointer;font:inherit;font-size:14px;font-weight:500;transition:background-color var(--d2) var(--ease),opacity var(--d2) var(--ease)}.btn:hover:not(:disabled){background:var(--fill)}.btn.primary:hover:not(:disabled){opacity:.86;background:var(--accent)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.btn.primary.brand,.btn.primary.brand:hover:not(:disabled){background:var(--brand);color:var(--on-brand);border-color:var(--brand)}
.btn.danger{background:transparent;color:var(--danger);border-color:var(--danger)}
.btn.ghost{border-color:transparent}
textarea.wide{inline-size:100%}
input:not([type=checkbox]):not([type=file]):focus-visible,select:focus-visible{border-color:var(--brand)}
input:not([type=checkbox]):not([type=file]),select{font:inherit;color:inherit;background:var(--surface);border:1px solid var(--text-secondary);border-radius:var(--r-md);min-block-size:var(--tap);padding-inline:var(--sp-md)}
textarea{font:inherit;color:inherit;background:var(--surface);border:1px solid var(--text-secondary);border-radius:var(--r-md);padding:var(--sp-sm) var(--sp-md)}
.row{display:flex;gap:var(--sp-sm);flex-wrap:wrap;align-items:center}.row.end{justify-content:flex-end;margin-block-start:var(--sp-lg)}
.notice{padding:var(--sp-md) var(--sp-lg);border:1px solid var(--hairline);border-radius:var(--r-md);background:var(--surface)}
.notice.error{border-color:var(--danger)}.notice.ok{border-color:var(--accent)}
.badge{display:inline-block;padding:3px var(--sp-md);border-radius:var(--r-pill);font-size:12px;border:1px solid transparent;background:var(--fill);color:var(--text-secondary)}
.badge.bad{border-color:var(--danger);color:var(--danger);background:transparent}.badge.ok{border-color:var(--accent);color:var(--accent);background:transparent}.badge.warn{border-style:dashed}
.dialog{border:0;border-radius:var(--r-xl);box-shadow:var(--shadow-lift);background:var(--background);color:var(--text-primary);padding:var(--sp-xl);max-inline-size:min(520px,92vw)}
.dialog::backdrop{background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}.dialog[open]{animation:enter var(--d2) var(--ease)}
.dialog label{display:block;margin-block:var(--sp-md) var(--sp-xs)}
.dialog select,.dialog input:not([type=checkbox]){inline-size:100%;min-block-size:var(--tap);padding-inline:var(--sp-sm)}
.check{display:flex;gap:var(--sp-sm);align-items:center;min-block-size:var(--tap)}
.kv{display:flex;gap:var(--sp-md);padding-block:var(--sp-xs)}.kv dt{color:var(--text-secondary);min-inline-size:140px;font-size:12px;padding-block-start:3px}.kv dd{margin:0}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-md);margin-block-end:var(--sp-lg);flex-wrap:wrap}
.meter{display:block;inline-size:120px;block-size:2px;border-radius:var(--r-md);background:var(--border);overflow:hidden}
.meter>span{display:block;block-size:100%;background:var(--accent)}.meter.late>span{background:var(--danger)}
.sr-only{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
table.dense th,table.dense td{padding:var(--sp-xs) var(--sp-sm);font-size:${typography.caption.fontSize}px}
tr.late-row{background:color-mix(in srgb,var(--danger) 8%,transparent)}
tr.differs th,tr.differs td{background:color-mix(in srgb,var(--accent) 6%,transparent)}
.sla.late{color:var(--danger);font-weight:600}
.sla-meter{display:block;inline-size:120px;block-size:2px;-webkit-appearance:none;appearance:none;border:0;background:var(--hairline)}
.sla-meter::-webkit-meter-bar{background:var(--hairline);border:0;block-size:2px}
.sla-meter::-webkit-meter-optimum-value,.sla-meter::-webkit-meter-suboptimum-value,.sla-meter::-webkit-meter-even-less-good-value{background:var(--text-primary)}
.sla-meter::-moz-meter-bar{background:var(--text-primary)}
.filters{display:flex;gap:var(--sp-md);flex-wrap:wrap;align-items:end}.filter label{display:block;color:var(--text-secondary);font-size:${typography.caption.fontSize}px}
.filters select,.filters input:not([type=checkbox]){min-block-size:var(--tap);padding-inline:var(--sp-sm)}
.tabs{margin-block:var(--sp-md)}.badges{margin-block:var(--sp-md)}
.split{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:var(--sp-lg);align-items:start}
@media (max-width:1000px){.split{grid-template-columns:minmax(0,1fr)}}
.main-col,.split>*{min-inline-size:0}.kv{flex-wrap:wrap}.kv dd{min-inline-size:0;overflow-wrap:anywhere}
.sticky{position:sticky;top:var(--sp-md)}
.actions .action{display:grid;gap:var(--sp-xs);margin-block:var(--sp-sm)}.actions .btn{inline-size:100%;display:flex;justify-content:space-between;align-items:center}
.gate-note{font-size:${typography.caption.fontSize}px}
kbd{border:1px solid var(--border);border-radius:var(--r-sm);padding:0 var(--sp-xs);font-size:${typography.caption.fontSize}px;background:var(--background)}
.consequences{padding-inline-start:var(--sp-lg)}
.field{margin-block:var(--sp-sm)}.field-error{color:var(--danger);margin:var(--sp-xs) 0 0}
.dialog.wide-dialog{max-inline-size:min(640px,94vw)}.dialog textarea.wide,.dialog select{inline-size:100%}
fieldset{border:0;border-block-start:1px solid var(--hairline);border-radius:var(--r-md)}
.doclist{list-style:none;padding:0;display:grid;gap:var(--sp-xs)}.doclist li{display:flex;gap:var(--sp-sm);align-items:center;flex-wrap:wrap}
.viewer{border:1px solid var(--hairline);border-radius:var(--r-lg);padding:var(--sp-md);margin-block:var(--sp-md)}
.viewer-stage{position:relative;overflow:hidden;min-block-size:240px;background:var(--surface)}
.viewer-img{display:block;max-inline-size:100%;margin-inline:auto;user-select:none}.viewer-frame{inline-size:100%;block-size:70vh;border:0}
.watermark{position:absolute;inset:0;pointer-events:none;display:grid;grid-template-columns:repeat(3,1fr);align-content:space-around;justify-items:center;opacity:.28;transform:rotate(-20deg) scale(1.4);font-weight:700;font-size:${typography.caption.fontSize}px;user-select:none}
.timeline{padding-inline-start:var(--sp-lg)}.timeline li{margin-block:var(--sp-xs)}
.tm{border-block-end:1px solid var(--border);padding-block:var(--sp-sm)}
.tiles{list-style:none;padding:0;display:flex;gap:var(--sp-md);flex-wrap:wrap}
.tile{display:grid;gap:var(--sp-xs);min-inline-size:160px;padding:var(--sp-md) var(--sp-md) var(--sp-md) 0;padding-inline:0 var(--sp-md);border-block-start:1px solid var(--hairline);text-decoration:none;color:var(--text-primary)}.tile:hover{border-block-start-color:var(--text-primary)}
.tile-n{font-family:var(--font-display);font-size:${typography.title1.fontSize}px;font-weight:400;font-variant-numeric:tabular-nums}
.skeleton{background:var(--fill);border-radius:var(--r-md);margin-block:var(--sp-sm);animation:pulse 1.4s ease-in-out infinite}.skeleton.h{block-size:36px;inline-size:40%}.skeleton.row-s{block-size:28px}.skeleton.block{block-size:160px}
${METER_CSS}
${uiWebCss(ADMIN_CSS)}
@keyframes pulse{50%{opacity:.5}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
`;
