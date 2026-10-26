// Cover image for a channel post: our own branded card (not a photo of the venue, so no image-rights question).
import { FONT_CSS } from "./fonts.generated";
import type { ExhibitionResearch } from "./exhibition";
import type { Brand } from "./template";
import { COLORS, logoSvg } from "./theme";

export const CARD_WIDTH = 1280;
export const CARD_HEIGHT = 720;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px}
body{font-family:Montserrat,sans-serif;background:${COLORS.navy};color:#fff;position:relative;overflow:hidden}
.deco{position:absolute;right:-120px;top:120px;opacity:.07}
.deco2{position:absolute;left:64px;top:150px;width:90px;height:3px;background:${COLORS.gold}}
.wrap{position:relative;height:100%;padding:56px 64px;display:flex;flex-direction:column}
.top{display:flex;justify-content:space-between;align-items:center}
.logo svg{height:62px;width:auto;display:block}
.tag{font-size:18px;letter-spacing:4px;text-transform:uppercase;color:${COLORS.gold};font-weight:600}
.kicker{margin-top:58px;color:${COLORS.gold};font-weight:800;letter-spacing:4px;font-size:22px;text-transform:uppercase}
h1{margin-top:14px;font-family:Cinzel,Montserrat,serif;font-size:84px;line-height:1.02;font-weight:700;letter-spacing:0;max-width:780px}
.meta{margin-top:30px;display:flex;gap:40px;font-size:28px;font-weight:600}
.meta span{display:inline-block;width:12px;height:12px;border-radius:3px;background:${COLORS.gold};margin-right:12px;vertical-align:middle;position:relative;top:-3px}
.tagline{margin-top:26px;font-size:26px;color:rgba(255,255,255,.72);max-width:700px;line-height:1.3}
.chips{position:absolute;left:64px;bottom:56px;display:flex;gap:10px;flex-wrap:wrap;max-width:700px}
.chip{border:2px solid rgba(198,164,106,.5);border-radius:999px;padding:8px 18px;font-size:19px;font-weight:600;color:#fff;background:rgba(255,255,255,.04)}
.budget{position:absolute;right:64px;bottom:56px;width:400px;background:${COLORS.gold};color:${COLORS.navy};border-radius:6px;padding:30px 34px}
.budget .k{font-size:17px;letter-spacing:2px;text-transform:uppercase;opacity:.7}
.budget .v{font-size:68px;font-weight:800;letter-spacing:-1.5px;margin-top:6px}
.budget .v.q{font-size:52px;letter-spacing:-1px}
.budget .s{font-size:19px;opacity:.85;margin-top:6px}
.budget .pdf{margin-top:18px;display:inline-block;background:${COLORS.navy};color:#fff;border-radius:10px;padding:10px 18px;font-weight:700;font-size:20px}
.sample{position:absolute;left:0;right:0;top:0;background:#c8102e;color:#fff;text-align:center;font-weight:700;font-size:16px;padding:6px;letter-spacing:2px}
`;

/** What the generic cover shows; each subject (exhibition, business model) fills it in its own way. */
export interface CardData {
  tag: string; // top right, e.g. "Ko'rgazma"
  kicker?: string;
  heading: string;
  meta: string[]; // up to 2 short facts with accent squares
  tagline?: string;
  chips: string[];
  box: { k: string; v: string; s?: string; cta: string; small?: boolean };
  sample?: boolean;
}

export function renderCardHtml(_brand: Brand, card: CardData): string {
  const meta = card.meta.length
    ? `<div class="meta">${card.meta.slice(0, 2).map((m) => `<div><span></span>${esc(m)}</div>`).join("")}</div>`
    : "";
  const chips = card.chips.length
    ? `<div class="chips">${card.chips.slice(0, 4).map((c) => `<div class="chip">${esc(c)}</div>`).join("")}</div>`
    : "";
  const box =
    `<div class="budget"><div class="k">${esc(card.box.k)}</div><div class="v${card.box.small ? "" : " q"}"${card.box.small ? ' style="font-size:48px"' : ""}>${esc(card.box.v)}</div>` +
    `${card.box.s ? `<div class="s">${esc(card.box.s)}</div>` : ""}<div class="pdf">${esc(card.box.cta)}</div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FONT_CSS}${CSS}</style></head><body>
<div class="deco">${logoSvg("mark", 150)}</div>
${card.sample ? `<div class="sample">NAMUNA · TEST</div>` : ""}
<div class="wrap">
  <div class="top"><div class="logo">${logoSvg("white", 16)}</div><div class="tag">${esc(card.tag)}</div></div>
  ${card.kicker ? `<div class="kicker">${esc(card.kicker)}</div>` : ""}
  <h1 style="${card.heading.length > 22 ? "font-size:68px" : ""}">${esc(card.heading)}</h1>
  ${meta}
  ${card.tagline ? `<div class="tagline">${esc(card.tagline)}</div>` : ""}
</div>
${chips}
${box}
</body></html>`;
}

export function exhibitionCard(title: string, research: ExhibitionResearch | null): CardData {
  const e = research?.exhibition;
  if (!e) return { tag: "Material", heading: title, meta: [], chips: [], box: { k: "Yangi material", v: "PDF", cta: "Botda oling", small: true } };
  const phase = e.phases.find((p) => p.name === e.focus_phase) ?? e.phases[0];
  return {
    tag: "Ko'rgazma",
    kicker: "Tadbirkorlar uchun · Xitoy",
    heading: `${e.name}${e.edition ? ` ${e.edition}` : ""}`,
    meta: [e.dates.value, `${e.city}, Xitoy`],
    tagline: e.tagline,
    chips: phase ? phase.categories.split(",").map((c) => c.trim()).filter(Boolean) : [],
    box: { k: "2 kishilik biznes-safar", v: "Narxi qancha?", s: "aviachipta · mehmonxona · transport", cta: "Botda bilib oling" },
    sample: research?.sample,
  };
}

export function renderPostCardHtml(brand: Brand, title: string, research: ExhibitionResearch | null): string {
  return renderCardHtml(brand, exhibitionCard(title, research));
}
