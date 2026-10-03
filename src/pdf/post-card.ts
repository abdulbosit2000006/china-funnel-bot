// Cover image for a channel post: our own branded card (not a photo of the venue, so no image-rights question).
import { FONT_CSS } from "./fonts.generated";
import type { ExhibitionResearch } from "./exhibition";
import type { Brand } from "./template";

export const CARD_WIDTH = 1280;
export const CARD_HEIGHT = 720;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px}
body{font-family:Inter,sans-serif;background:#f4f0ea;color:#15171a;position:relative;overflow:hidden}
.deco{position:absolute;right:-140px;top:-120px;width:620px;height:620px;border-radius:50%;background:rgba(181,98,42,.10)}
.deco2{position:absolute;right:180px;bottom:-260px;width:420px;height:420px;border-radius:50%;background:rgba(181,98,42,.06)}
.wrap{position:relative;height:100%;padding:56px 64px;display:flex;flex-direction:column}
.top{display:flex;justify-content:space-between;align-items:center}
.logo{display:flex;align-items:center;gap:14px;font-weight:800;font-size:26px;letter-spacing:.3px}
.mark{width:46px;height:46px;border-radius:8px;background:#b5622a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px}
.tag{font-size:18px;letter-spacing:3px;text-transform:uppercase;color:#6b6660;font-weight:600}
.kicker{margin-top:58px;color:#b5622a;font-weight:800;letter-spacing:4px;font-size:22px;text-transform:uppercase}
h1{margin-top:14px;font-size:92px;line-height:.98;font-weight:800;letter-spacing:-3px;max-width:760px}
.meta{margin-top:30px;display:flex;gap:40px;font-size:28px;font-weight:600}
.meta span{display:inline-block;width:12px;height:12px;border-radius:3px;background:#b5622a;margin-right:12px;vertical-align:middle;position:relative;top:-3px}
.tagline{margin-top:26px;font-size:26px;color:#4a4540;max-width:700px;line-height:1.3}
.chips{position:absolute;left:64px;bottom:56px;display:flex;gap:10px;flex-wrap:wrap;max-width:700px}
.chip{border:2px solid #d9d2c7;border-radius:999px;padding:8px 18px;font-size:19px;font-weight:600;color:#4a4540;background:rgba(255,255,255,.5)}
.budget{position:absolute;right:64px;bottom:56px;width:400px;background:#15171a;color:#fff;border-radius:18px;padding:30px 34px}
.budget .k{font-size:17px;letter-spacing:2px;text-transform:uppercase;opacity:.7}
.budget .v{font-size:68px;font-weight:800;letter-spacing:-1.5px;margin-top:6px}
.budget .v.q{font-size:52px;letter-spacing:-1px}
.budget .s{font-size:19px;opacity:.85;margin-top:6px}
.budget .pdf{margin-top:18px;display:inline-block;background:#b5622a;border-radius:10px;padding:10px 18px;font-weight:700;font-size:20px}
.sample{position:absolute;left:0;right:0;top:0;background:#c8102e;color:#fff;text-align:center;font-weight:700;font-size:16px;padding:6px;letter-spacing:2px}
`;

export function renderPostCardHtml(brand: Brand, title: string, research: ExhibitionResearch | null): string {
  const e = research?.exhibition;
  const heading = e ? `${e.name}${e.edition ? ` ${e.edition}` : ""}` : title;
  const meta = e
    ? `<div class="meta"><div><span></span>${esc(e.dates.value)}</div><div><span></span>${esc(e.city)}, Xitoy</div></div>`
    : "";
  const box =
    research
      ? `<div class="budget"><div class="k">2 kishilik biznes-safar</div><div class="v q">Narxi qancha?</div>` +
        `<div class="s">aviachipta · mehmonxona · transport</div><div class="pdf">Botda bilib oling</div></div>`
      : `<div class="budget"><div class="k">Yangi material</div><div class="v" style="font-size:48px">PDF</div><div class="pdf">Botda oling</div></div>`;
  const phase = e ? (e.phases.find((p) => p.name === e.focus_phase) ?? e.phases[0]) : undefined;
  const chips = phase
    ? `<div class="chips">${phase.categories
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 4)
        .map((c) => `<div class="chip">${esc(c)}</div>`)
        .join("")}</div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FONT_CSS}${CSS}</style></head><body>
<div class="deco"></div><div class="deco2"></div>
${research?.sample ? `<div class="sample">NAMUNA · TEST</div>` : ""}
<div class="wrap">
  <div class="top"><div class="logo"><span class="mark">${esc(brand.mark)}</span>${esc(brand.name)}</div><div class="tag">${e ? "Ko'rgazma" : "Material"}</div></div>
  ${e ? `<div class="kicker">Tadbirkorlar uchun · Xitoy</div>` : ""}
  <h1 style="${heading.length > 22 ? "font-size:68px" : ""}">${esc(heading)}</h1>
  ${meta}
  ${e?.tagline ? `<div class="tagline">${esc(e.tagline)}</div>` : ""}
</div>
${chips}
${box}
</body></html>`;
}
