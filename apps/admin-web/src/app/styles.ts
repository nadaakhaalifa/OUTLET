import { colors, radius, spacing, typography, minTouchTarget } from "@outlet/ui-tokens";
import { ADMIN_CSS, colorVars, motionVars, shadowVars, uiWebCss } from "@outlet/ui-web/css";
import { METER_CSS } from "../view-models/meter";

const vars = (s: "light" | "dark"): string => colorVars(colors[s], "--");
const shadowVarsFor = (dark: boolean): string => shadowVars(dark ? "dark" : "light");

/** Token-driven stylesheet, logical properties only so RTL is the default and LTR mirrors for free. */
export const STYLES = `
:root{${vars("light")}${shadowVarsFor(false)}--sp-xs:${spacing.xs}px;--sp-sm:${spacing.sm}px;--sp-md:${spacing.md}px;--sp-lg:${spacing.lg}px;--sp-xl:${spacing.xl}px;--sp-xxl:${spacing.xxl}px;--sp-xxxl:${spacing.xxxl}px;--r-sm:${radius.sm}px;--r-md:${radius.md}px;--r-lg:${radius.lg}px;--r-xl:${radius.xl}px;--r-pill:${radius.pill}px;--tap:${minTouchTarget}px;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${vars("dark")}${shadowVarsFor(true)}}}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{${vars("dark")}${shadowVarsFor(true)}color-scheme:dark}
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
.skip{position:absolute;inset-inline-start:-9999px;display:inline-flex;align-items:center;min-block-size:var(--tap)}.skip:focus{inset-inline-start:var(--sp-md);top:var(--sp-md);background:var(--surface);padding-inline:var(--sp-md);z-index:30}
html,body{overflow-x:clip}
.shell{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
@media (max-width:800px){.shell{grid-template-columns:minmax(0,1fr)}}
.side{background:var(--background);border-inline-end:1px solid var(--hairline)}
.side-inner{position:sticky;inset-block-start:0;max-block-size:100vh;overflow-y:auto;padding:var(--sp-xl) var(--sp-lg)}
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
@media (max-width:800px){.side{display:none}main{padding:var(--sp-xl) var(--sp-lg)!important}}
main{padding:var(--sp-xxl) var(--sp-xxl) 64px;max-inline-size:1200px;inline-size:100%;animation:enter var(--d3) var(--ease) both}
@keyframes enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.topbar{position:sticky;inset-block-start:0;z-index:4;padding-block:var(--sp-sm);margin-inline:calc(var(--sp-xxl)*-1);padding-inline:var(--sp-xxl);background:var(--glass-tint);border-block-end:1px solid var(--glass-border);-webkit-backdrop-filter:saturate(1.4) blur(18px);backdrop-filter:saturate(1.4) blur(18px)}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.topbar{background:var(--glass-solid)}}
@media (prefers-reduced-transparency:reduce){.topbar{background:var(--glass-solid);-webkit-backdrop-filter:none;backdrop-filter:none}}
@media (max-width:800px){.topbar{margin-inline:calc(var(--sp-lg)*-1);padding-inline:var(--sp-lg);inset-block-start:0;background:var(--surface);-webkit-backdrop-filter:none;backdrop-filter:none}.topbar>.who,.topbar>.row{display:none}}
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
.nav-heading{margin:0 0 var(--sp-xs);padding-inline:var(--sp-sm);font-size:${typography.eyebrow.fontSize}px;line-height:${typography.eyebrow.lineHeight}px;font-weight:500;color:var(--text-secondary)}
.menu{display:none}
.menu>summary{position:relative;z-index:21;background:var(--surface)}
.menu>summary{list-style:none;display:inline-flex;align-items:center}.menu>summary::-webkit-details-marker{display:none}
.menu-panel{position:fixed;inset-block-start:0;block-size:100dvh;max-block-size:100dvh;overscroll-behavior:contain;inset-inline-start:0;inline-size:min(320px,86vw);overflow-y:auto;z-index:20;background:var(--surface);border-inline-end:1px solid var(--hairline);box-shadow:var(--shadow-lift);padding:calc(var(--tap) + var(--sp-xxxl) + var(--sp-md)) var(--sp-lg) var(--sp-xl)}
.menu-foot{margin-block-start:var(--sp-lg);padding-block-start:var(--sp-lg);border-block-start:1px solid var(--hairline);display:grid;gap:var(--sp-sm)}.menu-foot .who{margin:0}.menu-foot .btn{inline-size:100%}
.menu-panel ul{list-style:none;margin:0;padding:0}
.menu-panel a{display:flex;align-items:center;min-block-size:var(--tap);padding-inline:var(--sp-sm);border-radius:var(--r-md);font-size:14px;text-decoration:none;color:var(--text-secondary)}
.menu-panel a[aria-current="page"]{color:var(--text-primary);font-weight:500;background:var(--brand-soft)}
@media (max-width:800px){.menu{display:block}}
.who{margin:0;margin-inline-end:auto;font-size:13px;display:flex;gap:var(--sp-xs);flex-wrap:wrap}
.eyebrow{margin:0 0 var(--sp-xs)}
.page-header .eyebrow{line-height:1.6;margin-block-end:var(--sp-sm)}
:lang(ar) .page-header h1{line-height:1.5}
.empty-state{padding:var(--sp-xxl) var(--sp-lg);text-align:center;border:1px dashed var(--hairline);border-radius:var(--r-lg)}.empty-title{margin:0 0 var(--sp-xs);font-weight:500}
.tile-section{margin-block:var(--sp-xl)}
.tile-grid{list-style:none;margin:0;padding:0;display:grid;gap:var(--sp-md);grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.tile-card{display:grid;gap:var(--sp-xs);align-content:start;background:var(--surface);border-radius:var(--r-lg);box-shadow:var(--shadow-card);padding:var(--sp-lg)}
.tile-label{margin:0;font-size:13px;font-weight:500;color:var(--text-secondary)}
.tile-note{margin:0;font-size:${typography.caption.fontSize}px}
.tile-link{display:inline-flex;align-items:center;min-block-size:var(--tap);font-size:13px;font-weight:500}
.tile-card .tile-n{margin:0;text-align:start}
.skeleton{background:var(--fill);border-radius:var(--r-md);margin-block:var(--sp-sm);animation:pulse 1.4s ease-in-out infinite}.skeleton.h{block-size:36px;inline-size:40%}.skeleton.row-s{block-size:28px}.skeleton.block{block-size:160px}
/* ---- HOME-CONTENT: tiles, attention strip, severity, states (owned by the home-content package) ---- */
.tile-n{font-variant-numeric:lining-nums tabular-nums;font-feature-settings:"lnum" 1,"tnum" 1}
.tile-card.sev-breach{border-inline-start:4px solid var(--danger)}
.tile-flag{margin:0;font-size:12px;font-weight:600;color:var(--danger);text-transform:none;letter-spacing:0}
.tile-quiet .tile-n{color:var(--text-secondary)}
.tile-compact{padding-block:var(--sp-md)}.tile-compact .tile-line{display:flex;align-items:baseline;gap:var(--sp-sm);margin:0}.tile-compact .tile-n{font-size:${typography.headline.fontSize}px}
.attention{margin-block:var(--sp-lg);padding:var(--sp-lg);background:var(--surface);border-radius:var(--r-lg);box-shadow:var(--shadow-card)}
.attention.calm{text-align:center}
.attention h2{margin:0 0 var(--sp-xs)}.attention-summary{margin:0 0 var(--sp-md);font-weight:500}
.attention-list{list-style:none;margin:0;padding:0;display:grid;gap:var(--sp-xs)}
.attention-row a{display:flex;align-items:center;gap:var(--sp-md);min-block-size:var(--tap);padding-inline:var(--sp-sm);border-radius:var(--r-md);text-decoration:none;color:var(--text-primary)}
.attention-row a:hover{background:var(--brand-soft)}
.attention-row.sev-breach{border-inline-start:4px solid var(--danger)}
.attention-n{font-family:var(--font-display);font-size:${typography.title2.fontSize}px;font-variant-numeric:lining-nums tabular-nums;font-feature-settings:"lnum" 1,"tnum" 1;min-inline-size:3ch}
.attention-why{flex:1;display:flex;flex-wrap:wrap;gap:var(--sp-xs);align-items:baseline}
[dir="rtl"] .flip{display:inline-block;transform:scaleX(-1)}
:lang(ar) .eyebrow{letter-spacing:normal}
/* ---- end HOME-CONTENT ---- */
/* ---- shell: nav groups, phone menu, crumbs, role chip, env badge, theme toggle ---- */
.nav-group{margin-block-end:var(--sp-sm)}
.nav-group>summary.nav-heading{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-sm);min-block-size:var(--tap);margin:0;cursor:pointer;list-style:none;border-radius:var(--r-md)}
.nav-group>summary::-webkit-details-marker{display:none}
.nav-group>summary::after{content:"";flex:none;inline-size:6px;block-size:6px;border-inline-end:1.5px solid currentColor;border-block-end:1.5px solid currentColor;transform:rotate(45deg);transition:transform var(--d2) var(--ease)}
.nav-group[open]>summary::after{transform:rotate(-135deg)}
.crumbs{display:none;margin-inline-end:auto;font-size:13px}
.crumbs ol{list-style:none;margin:0;padding:0;display:flex;gap:var(--sp-sm);align-items:center}
.crumbs li:not(:last-child){color:var(--text-secondary)}
.crumbs li:not(:last-child)::after{content:"/";margin-inline-start:var(--sp-sm)}
.crumbs li[aria-current]{font-weight:500}
@media (min-width:801px){.crumbs{display:block}.topbar>.who{margin-inline-end:0}}
.env{white-space:nowrap}
.rolechip{position:relative}
.rolechip>summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;min-block-size:var(--tap);padding-inline:var(--sp-md);background:var(--fill)}
.rolechip>summary::-webkit-details-marker{display:none}
.rolechip-list{position:absolute;inset-inline-start:0;inset-block-start:100%;z-index:25;min-inline-size:160px;list-style:none;margin:0;padding:var(--sp-sm) var(--sp-md);background:var(--surface);border:1px solid var(--hairline);border-radius:var(--r-md);box-shadow:var(--shadow-lift);display:grid;gap:var(--sp-xs)}
.theme-toggle{display:inline-flex;gap:0;align-items:center}
.theme-group{display:contents}
.theme-toggle .btn{padding-inline:var(--sp-md)}
.theme-toggle .btn[aria-pressed="true"]{background:var(--brand-soft);border-color:var(--brand)}
.menu-foot .theme-toggle{display:grid;grid-template-columns:repeat(3,1fr)}
.menu-foot .theme-toggle .btn{inline-size:auto}
/* ---- end shell ---- */
${METER_CSS}
${uiWebCss(ADMIN_CSS)}
@keyframes pulse{50%{opacity:.5}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
`;
