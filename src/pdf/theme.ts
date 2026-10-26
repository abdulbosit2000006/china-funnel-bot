// MERIDIAN brand look for every client PDF (logobook 2026): navy cover, ivory pages, gold accents,
// Cinzel for Latin headings, Montserrat for text. Templates keep their layout and pull colors from here.
import { LOGO_LOCKUP_NAVY, LOGO_LOCKUP_WHITE, LOGO_MARK } from "./brand.generated";

export const COLORS = { navy: "#0B1F3A", gold: "#C6A46A", charcoal: "#2B2B2B", ivory: "#F7F4EE" } as const;
export const SLOGAN = "CONNECTING OPPORTUNITIES. DELIVERING GROWTH.";

/** Inline logo, sized by height. "white" goes on navy, "navy" on light backgrounds. */
export function logoSvg(variant: "white" | "navy" | "mark", heightMm: number): string {
  const svg = variant === "white" ? LOGO_LOCKUP_WHITE : variant === "navy" ? LOGO_LOCKUP_NAVY : LOGO_MARK;
  return svg.replace("<svg ", `<svg style="height:${heightMm}mm;width:auto;display:block" `);
}

/** Page footer for Chromium's footerTemplate (its own document: inline styles only, no web fonts). */
export function brandFooter(left: string): string {
  return `<div style="width:100%;font-size:7pt;color:#7d7668;padding:0 15mm;display:flex;justify-content:space-between;align-items:center;font-family:sans-serif;letter-spacing:.3px"><span style="display:flex;align-items:center;gap:6px"><span style="color:${COLORS.navy};font-weight:700;letter-spacing:2px">MERIDIAN</span><span style="color:${COLORS.gold}">|</span><span>${left}</span></span><span style="color:${COLORS.navy}"><span class="pageNumber"></span></span></div>`;
}

export const THEME_TOKENS = `:root{--head:${COLORS.navy};--head2:#8a6d3b;--accent:${COLORS.gold};--accent-soft:#efe4cf;--accent-ink:#7a6236;--mark-ink:${COLORS.navy};--ink:${COLORS.charcoal};--muted:#6e695f;--line:#e2d9c8;--soft:#efe9dd;--dark:${COLORS.navy};--dark-ink:#fff;--cover-bg:${COLORS.navy};--cover-ink:#fff;--cover-muted:rgba(255,255,255,.68);--cover-rule:rgba(198,164,106,.4);--cover-deco:transparent;--total-bg:${COLORS.gold};--total-ink:${COLORS.navy};--paper:${COLORS.ivory}}`;

/** Appended after a template's own CSS, so these rules win. */
export const THEME_CSS = `
@page{background:${COLORS.ivory}}
html{background:var(--paper)}
body{font-family:Montserrat,"DejaVu Sans",sans-serif;background:var(--paper)}
h2{font-family:Cinzel,Montserrat,serif;font-weight:700;font-size:17pt;letter-spacing:.4px;padding-bottom:2.2mm;border-bottom:.6mm solid var(--accent);margin-bottom:5mm}
h2 .n{font-family:Montserrat,sans-serif;font-weight:600;font-size:11pt;color:var(--accent);letter-spacing:1px;vertical-align:2pt;margin-right:3mm}
h3{font-weight:700;letter-spacing:.1px}
th{border-bottom:1.5px solid var(--head);color:var(--head)}
.card,.pain,.photo{background:#fff}
.kpibox{background:#fff;border-top:.8mm solid var(--accent)}
tr.total td{background:var(--head);color:#fff}
tr.total td.num{color:var(--accent)}
.callout{background:#fff;border-left-color:var(--accent)}
.cta{background:var(--head);border-top:1mm solid var(--accent)}
.cta .btn{background:var(--accent);color:var(--head)}
.steps li:before{background:var(--head);color:var(--accent)}
ul.check li:before{border-color:var(--accent)}
/* cover */
.cover{background:var(--cover-bg);color:var(--cover-ink)}
.cover .top{align-items:flex-start;color:var(--accent);letter-spacing:2.5px;font-weight:600}
.cover .top .logo{display:block}
.cover .kicker{color:var(--accent);margin-top:30mm;letter-spacing:4px}
.cover h1{font-family:Cinzel,Montserrat,serif;font-weight:700;letter-spacing:.5px;line-height:1.08;color:#fff}
.cover .sub,.cover .tag{color:var(--cover-muted)}
.cover .rule{width:28mm;height:.7mm;background:var(--accent);margin-top:7mm}
.cover .fact{border-top-color:var(--cover-rule)}
.cover .fact .k{color:var(--accent)}
.cover .fact .v{color:#fff}
.cover .total{background:var(--total-bg);color:var(--total-ink);border-radius:1mm}
.cover .total .k{opacity:.8}
.cover .kpi{background:var(--total-bg);color:var(--total-ink);border-radius:1mm}
.cover .kpi.light{background:rgba(255,255,255,.06);color:#fff;border:1px solid var(--cover-rule)}
.cover .kpi.light .v.neg{color:#ff9b8f}
.cover .disc{border-color:var(--accent);color:var(--accent)}
.cover .foot{color:var(--cover-muted);border-top-color:var(--cover-rule)}
.cover .foot b{color:#fff}
.cover .slogan{margin-top:4mm;color:var(--accent);font-size:7.5pt;letter-spacing:3px;font-weight:600}
.cover .bigmark{position:absolute;right:-22mm;bottom:38mm;opacity:.07;pointer-events:none}
.cover .deco{display:none}
`;

/** Cover pieces shared by the templates. */
export const coverLogo = () => `<div class="logo">${logoSvg("white", 13)}</div>`;
export const coverMark = () => `<div class="bigmark">${logoSvg("mark", 120)}</div>`;
export const coverSlogan = () => `<div class="slogan">${SLOGAN}</div>`;
