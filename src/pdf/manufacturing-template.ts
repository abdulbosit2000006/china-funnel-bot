// Production business idea PDF: same copper look as the exhibition guide, Uzbek Latin text.
import { FONT_CSS } from "./fonts.generated";
import { DATA_LABELS, money, type DataLabel, type Labeled } from "./exhibition";
import {
  type Calc,
  type LabeledNumber,
  type ManufacturingModel,
  type ManufacturingResearch,
  type MoneyRow,
  moneySigned,
  moneyUnit,
  num,
  pct,
} from "./manufacturing";
import { LABEL_UZ, badge, esc, fmtDate, src, type Brand, type BrandContent } from "./template";

export function manufacturingFooter(brand: Brand, data: ManufacturingResearch): string {
  return `<div style="width:100%;font-size:7pt;color:#8a94a3;padding:0 15mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>${esc(brand.name)} · ${esc(data.product.name)} · research ${esc(data.research_date)}</span><span class="pageNumber"></span></div>`;
}

const DISCLAIMER = "Dastlabki model, investitsiya kafolati emas";

const lab = (x: Labeled) => `${esc(x.value)} ${badge(x.label)}${src(x.source)}`;
const labNum = (x: LabeledNumber, fmt: (n: number) => string) =>
  `${x.value === null ? "noma'lum" : fmt(x.value)} ${badge(x.label)}${src(x.source)}${x.note ? `<span class="note">${esc(x.note)}</span>` : ""}`;
const calc = (c: Calc) => `<span class="formula">${esc(c.formula)}</span>`;
const signedClass = (x: number | null) => (x !== null && x < 0 ? " neg" : "");

function moneyTable(rows: MoneyRow[], fmt: (x: number) => string, totalTitle: string, total: string, extra = ""): string {
  return `<table><thead><tr><th>Xarajat</th><th>Belgi</th><th class="num">Summa</th></tr></thead><tbody>
  ${rows
    .map(
      (r) =>
        `<tr class="${r.included ? "" : "unknown"}"><td><b>${esc(r.title)}</b>${src(r.source)}${r.note ? `<span class="note">${esc(r.note)}</span>` : ""}</td><td>${badge(r.label)}</td><td class="num">${r.included ? fmt(r.amount!) : "noma'lum"}</td></tr>`,
    )
    .join("")}
  ${extra}
  <tr class="total"><td colspan="2">${esc(totalTitle)}</td><td class="num">${total}</td></tr>
  </tbody></table>`;
}

export interface ManufacturingRenderOptions {
  /** Overrides equipment.image_url (e.g. a data: URI fetched in advance); null hides the photo. */
  imageSrc?: string | null;
}

export function renderManufacturingHtml(
  data: ManufacturingResearch,
  model: ManufacturingModel,
  brand: Brand,
  content: BrandContent,
  options: ManufacturingRenderOptions = {},
): string {
  const e = data.equipment;
  const mk = data.market;
  const p = data.production;
  const unit = data.product.unit;
  const date = fmtDate(data.research_date);
  const image = options.imageSrc === undefined ? e.image_url : options.imageSrc;
  const op = model.month.operating_profit.value!;
  const paybackText = model.payback.value === null ? "hisoblanmaydi" : `${num(model.payback.value)} oy`;
  const beText = model.break_even.utilization.value === null ? "yo'q" : `${num(model.break_even.utilization.value)}% yuklama`;
  const notIn = (rows: { title: string }[]) => rows.map((r) => esc(r.title)).join(", ");
  const calcBadge = `${badge("CALCULATED")}`;
  const sec = (n: number, title: string) => `<h2><span class="n">${String(n).padStart(2, "0")}</span>${title}</h2>`;
  let n = 0;
  const next = (title: string) => sec(++n, title);

  return `<!doctype html><html lang="uz"><head><meta charset="utf-8">
<style>${FONT_CSS}
:root{--head:#15171a;--head2:#8a4a1f;--accent:#b5622a;--accent-soft:#f6e6da;--accent-ink:#8a4a1f;--mark-ink:#fff;--ink:#22252a;--muted:#6b7079;--line:#e7e3dd;--soft:#f7f4ef;--dark:#15171a;--dark-ink:#fff;--cover-bg:#f4f0ea;--cover-ink:#15171a;--cover-muted:#6b6660;--cover-rule:#d9d2c7;--cover-deco:rgba(181,98,42,.08);--total-bg:#15171a;--total-ink:#fff}
@page{size:A4;margin:16mm 15mm 18mm}
@page:first{margin:0}
*{box-sizing:border-box}
body{font-family:Inter,"DejaVu Sans",sans-serif;color:var(--ink);font-size:10pt;line-height:1.45;margin:0}
h2{font-size:17pt;color:var(--head);margin:0 0 4mm;letter-spacing:-.2px}
h2 .n{color:var(--accent);margin-right:2mm}
h3{font-size:11.5pt;color:var(--head);margin:6mm 0 2mm}
p{margin:0 0 2.5mm}
.page{page-break-after:always}
.page:last-child{page-break-after:auto}
.watermark{position:fixed;top:45%;left:0;right:0;text-align:center;transform:rotate(-28deg);font-size:90pt;font-weight:800;color:rgba(200,16,46,.07);z-index:0;pointer-events:none}
/* cover */
.cover{height:297mm;background:var(--cover-bg);color:var(--cover-ink);padding:18mm 18mm 16mm;position:relative;display:flex;flex-direction:column;overflow:hidden}
.cover .top{display:flex;justify-content:space-between;align-items:center;font-size:8.5pt;letter-spacing:1.5px;text-transform:uppercase;color:var(--cover-muted)}
.logo{text-transform:none;display:flex;align-items:center;gap:2.5mm;color:var(--cover-ink);letter-spacing:.3px;font-weight:800;font-size:10.5pt}
.logo .mark{width:8.5mm;height:8.5mm;background:var(--accent);color:var(--mark-ink);display:flex;align-items:center;justify-content:center;font-size:9pt;letter-spacing:0;border-radius:1.2mm}
.cover .kicker{margin-top:34mm;color:var(--accent);font-weight:700;letter-spacing:3px;font-size:9.5pt;text-transform:uppercase}
.cover h1{font-size:40pt;line-height:1.02;margin:4mm 0 0;font-weight:800;letter-spacing:-1.2px}
.cover .sub{font-size:13pt;margin-top:5mm;color:var(--cover-muted)}
.cover .facts{margin-top:14mm;display:grid;grid-template-columns:1fr 1fr;gap:0 8mm}
.cover .fact{border-top:1px solid var(--cover-rule);padding:3.5mm 0 4mm}
.cover .fact .k{font-size:7.8pt;color:var(--cover-muted);text-transform:uppercase;letter-spacing:1.2px}
.cover .fact .v{font-size:11.5pt;font-weight:600;margin-top:1mm}
.cover .total{margin-top:8mm;background:var(--total-bg);color:var(--total-ink);border-radius:2mm;padding:6mm 7mm;display:flex;justify-content:space-between;align-items:flex-end}
.cover .total .k{font-size:9pt;opacity:.75;text-transform:uppercase;letter-spacing:1px}
.cover .total .v{font-size:30pt;font-weight:800;letter-spacing:-.5px;margin-top:1mm}
.cover .total .pp{font-size:9pt;opacity:.85;text-align:right}
.cover .total .pp b{font-size:15pt;display:block;margin-top:1mm}
.cover .foot{margin-top:auto;font-size:8.3pt;color:var(--cover-muted);line-height:1.5;border-top:1px solid var(--cover-rule);padding-top:4mm}
.cover .samplebar{position:absolute;top:0;left:0;right:0;background:#c8102e;color:#fff;text-align:center;font-weight:700;font-size:8.5pt;padding:1.8mm;letter-spacing:1px}
.cover .deco{position:absolute;right:-30mm;top:40mm;width:120mm;height:120mm;background:var(--cover-deco);border-radius:50%;pointer-events:none}
/* tables */
table{width:100%;border-collapse:collapse;font-size:9.3pt}
th{text-align:left;font-weight:600;color:var(--muted);font-size:8.3pt;text-transform:uppercase;letter-spacing:.5px;border-bottom:1.5px solid var(--head);padding:2mm 2mm}
td{border-bottom:1px solid var(--line);padding:2.2mm 2mm;vertical-align:top}
td.num,th.num{text-align:right;white-space:nowrap}
.note,td .note{display:block;color:var(--muted);font-size:8.2pt;margin-top:.5mm}
tr.sum td{font-weight:600;background:var(--soft)}
tr.total td{font-weight:800;font-size:11pt;background:var(--dark);color:var(--dark-ink);border:none}
tr.unknown td{color:var(--muted)}
.kv{display:grid;grid-template-columns:42mm 1fr;gap:2mm 4mm;margin-bottom:4mm}
.kv .k{color:var(--muted)}
.kv .v{font-weight:500}
.badge{display:inline-block;font-size:6.8pt;font-weight:700;letter-spacing:.4px;padding:.4mm 1.5mm;border-radius:1mm;vertical-align:middle;white-space:nowrap}
.b-verified{background:#e3f4e8;color:#1c6b35}.b-market-data{background:#e4eefb;color:#1d4f91}
.b-calculated{background:#ece8fb;color:#4b3a9a}.b-estimated{background:#fff3dc;color:#8a5a00}
.b-assumption{background:#fde9e0;color:#9a3d12}.b-unknown{background:#eceff2;color:#4c5562}
.src{color:var(--head2);font-size:7pt}
.callout{border-left:1.2mm solid var(--accent);background:var(--soft);padding:3.5mm 4.5mm;margin:4mm 0;border-radius:0 2mm 2mm 0}
.callout b{color:var(--head)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:4mm}
.card{border:1px solid var(--line);border-radius:2.5mm;padding:3.5mm 4mm}
.card .t{font-weight:700;color:var(--head);margin-bottom:1mm}
ul{margin:0;padding-left:5mm}li{margin-bottom:1.3mm}
ul.check{list-style:none;padding-left:0}ul.check li{padding-left:6.5mm;position:relative}
ul.check li:before{content:"";position:absolute;left:0;top:.6mm;width:3.4mm;height:3.4mm;border:1.3px solid var(--head);border-radius:.8mm}
.prog td:first-child{font-weight:700;color:var(--head);white-space:nowrap;width:16mm}
.cta{background:var(--dark);color:var(--dark-ink);border-radius:4mm;padding:7mm 8mm;margin-top:5mm}
.cta h3{color:var(--dark-ink);margin:0 0 2mm;font-size:14pt}
.cta .btn{display:inline-block;background:var(--accent);color:var(--mark-ink);font-weight:700;padding:2.5mm 6mm;border-radius:2mm;margin-top:3mm;text-decoration:none}
.lead{font-size:11pt;line-height:1.5;margin-bottom:5mm}
.pains{display:grid;gap:2.5mm}
.pain{display:grid;grid-template-columns:10mm 1fr;gap:3mm;border:1px solid var(--line);border-radius:2.5mm;padding:3mm 4mm}
.pn{font-size:15pt;font-weight:800;color:var(--accent);line-height:1}
.pt{font-weight:700;color:var(--head);font-size:10.5pt}
.ps{font-size:9.3pt}.ps b{color:var(--accent-ink)}
ul.ok li:before{content:"✓";position:absolute;left:0;color:var(--accent);font-weight:800}
ul.ok{list-style:none;padding:0}ul.ok li{padding-left:5.5mm;position:relative}
.legend td{font-size:8.5pt;padding:1.5mm 2mm}
.sources td{font-size:8.5pt}
.sources a{color:var(--head2);text-decoration:none;word-break:break-all}
.small{font-size:8.3pt;color:var(--muted)}
.cover .kpis{margin-top:8mm;display:grid;grid-template-columns:1.25fr 1fr 1fr;gap:3mm}
.cover .kpi{background:var(--total-bg);color:var(--total-ink);border-radius:2mm;padding:5mm 5mm}
.cover .kpi.light{background:#fff;color:var(--cover-ink);border:1px solid var(--cover-rule)}
.cover .kpi .k{font-size:7.8pt;opacity:.75;text-transform:uppercase;letter-spacing:1px}
.cover .kpi .v{font-size:21pt;font-weight:800;letter-spacing:-.4px;margin-top:1.5mm}
.cover .kpi .s{font-size:8pt;opacity:.8;margin-top:1mm}
.cover h1{font-size:34pt}
.cover .tag{font-size:12.5pt;margin-top:5mm;color:var(--cover-muted);max-width:150mm}
.cover .disc{display:inline-block;margin-top:6mm;border:1px solid var(--accent);color:var(--accent-ink);border-radius:1.5mm;padding:1.5mm 3mm;font-size:8.5pt;font-weight:600}
.kpigrid{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm;margin:3mm 0 5mm}
.kpibox{border:1px solid var(--line);border-radius:2.5mm;padding:3.5mm 3.5mm;background:var(--soft)}
.kpibox .k{font-size:7.6pt;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.kpibox .v{font-size:15pt;font-weight:800;color:var(--head);margin-top:1mm}
.kpibox .v.neg,.neg{color:#b42318}
.formula{display:block;color:var(--muted);font-size:8pt;margin-top:.6mm;font-variant-numeric:tabular-nums}
.photo{border:1px solid var(--line);border-radius:2.5mm;overflow:hidden;background:#fff;text-align:center;margin:0 0 4mm;break-inside:avoid}
.photo img{display:block;width:100%;height:68mm;object-fit:contain;background:#fff}
.photo .cap{font-size:7.8pt;color:var(--muted);padding:1.5mm 3mm;border-top:1px solid var(--line);text-align:left}
.pnl td.num{font-variant-numeric:tabular-nums}
.pnl tr.minus td:first-child{padding-left:6mm;color:var(--ink)}
.pnl tr.res td{font-weight:700;background:var(--soft)}
.steps{counter-reset:s;list-style:none;padding:0;margin:0}
.steps li{counter-increment:s;position:relative;padding:0 0 3mm 11mm;margin:0}
.steps li:before{content:counter(s);position:absolute;left:0;top:-.3mm;width:7mm;height:7mm;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;font-size:8.5pt;display:flex;align-items:center;justify-content:center}
.block{break-inside:avoid}
table{break-inside:auto}tr{break-inside:avoid}
h2,h3{break-after:avoid}
.warn{border-left:1.2mm solid #b42318;background:#fdf0ee;padding:3mm 4.5mm;margin:3mm 0;border-radius:0 2mm 2mm 0;font-size:9pt}
.warn ul{margin-top:1mm}
.card h2{font-size:12.5pt;margin:0 0 2.5mm}
</style></head><body>
${data.sample ? `<div class="watermark">NAMUNA</div>` : ""}

<section class="page cover">
  <div class="deco"></div>
  ${data.sample ? `<div class="samplebar">NAMUNA: SHABLON KO'RINISHI. RAQAMLAR TEKSHIRILMAGAN</div>` : ""}
  <div class="top"><div class="logo"><span class="mark">${esc(brand.mark)}</span>${esc(brand.name)}</div><div>Ishlab chiqarish g'oyasi</div></div>
  <div class="kicker">Biznes model · O'zbekiston</div>
  <h1>${esc(data.product.name)}</h1>
  <div class="tag">${esc(data.product.tagline)}</div>
  <div class="facts">
    <div class="fact"><div class="k">Tanlangan liniya</div><div class="v">${esc(e.name)}</div></div>
    <div class="fact"><div class="k">Quvvat (nominal)</div><div class="v">${num(model.capacity.per_hour_nominal)} ${esc(unit)}/soat</div></div>
    <div class="fact"><div class="k">Oylik ishlab chiqarish (${pct(p.utilization_base)} yuklama)</div><div class="v">${num(model.month.units)} ${esc(unit)}</div></div>
    <div class="fact"><div class="k">Sotish narxi (1 ${esc(unit)})</div><div class="v">${moneyUnit(model.unit.price)}</div></div>
  </div>
  <div class="kpis">
    <div class="kpi"><div class="k">Boshlang'ich investitsiya</div><div class="v">${money(model.capex.total)}</div><div class="s">${model.capex.excluded.length ? "+ noma'lum xarajatlar" : "CAPEX"}</div></div>
    <div class="kpi light"><div class="k">Oylik operatsion foyda</div><div class="v${signedClass(op)}">${moneySigned(op)}</div><div class="s">asosiy ssenariy</div></div>
    <div class="kpi light"><div class="k">Qoplanish muddati</div><div class="v">${paybackText}</div><div class="s">CAPEX ÷ oylik foyda</div></div>
  </div>
  <div class="disc">${DISCLAIMER}</div>
  <div class="foot">
    Research sanasi: <b>${date}</b>. Narxlar ${date} holatiga ko'ra; uskuna, xomashyo narxi va valyuta kursi o'zgarishi mumkin.
    Barcha hisob-kitoblar kiritilgan ma'lumotlar asosida formula bilan qilingan va eng zaif ma'lumot darajasi: <b>${esc(model.weakest)}</b>.
  </div>
</section>

<section class="page">
  ${next("Qisqacha xulosa")}
  <p class="lead">${esc(data.product.tagline)}. ${esc(mk.summary)}</p>
  <div class="kpigrid">
    <div class="kpibox"><div class="k">CAPEX</div><div class="v">${money(model.capex.total)}</div></div>
    <div class="kpibox"><div class="k">Oylik tushum</div><div class="v">${money(model.month.revenue.value!)}</div></div>
    <div class="kpibox"><div class="k">Operatsion foyda / oy</div><div class="v${signedClass(op)}">${moneySigned(op)}</div></div>
    <div class="kpibox"><div class="k">Qoplanish</div><div class="v">${paybackText}</div></div>
  </div>
  <h3>Nega bu g'oya qiziq</h3>
  <ul class="ok">${data.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>
  <h3>Asosiy raqamlar (${pct(p.utilization_base)} yuklama)</h3>
  <div class="kv">
    <div class="k">Oylik ishlab chiqarish</div><div class="v">${num(model.month.units)} ${esc(unit)} ${calcBadge}</div>
    <div class="k">To'liq tannarx (1 ${esc(unit)})</div><div class="v">${moneyUnit(model.unit.cost.value!)} ${calcBadge}</div>
    <div class="k">Sotish narxi (1 ${esc(unit)})</div><div class="v">${labNum(mk.selling_price_per_unit, moneyUnit)}</div>
    <div class="k">Zararsizlik nuqtasi</div><div class="v">${beText} ${calcBadge}</div>
    <div class="k">Operatsion rentabellik</div><div class="v">${model.month.margin_pct === null ? "—" : `${num(model.month.margin_pct)}%`} ${calcBadge}</div>
  </div>
  ${model.warnings.length ? `<div class="warn"><b>Diqqat:</b><ul>${model.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
  <div class="callout"><b>${DISCLAIMER}.</b> Bu model ochiq manbalardagi ma'lumotlar va farazlar asosida tuzilgan. Investitsiya qilishdan oldin «Investitsiyadan oldin nimani tekshirish kerak» bo'limidagi barcha punktlarni tekshiring.</div>
</section>

<section class="page">
  ${next("Mahsulot")}
  <p>${esc(data.product.description)}</p>
  <div class="kv">
    <div class="k">O'lchov birligi</div><div class="v">${esc(unit)}</div>
    <div class="k">Sotish narxi (modelda)</div><div class="v">${labNum(mk.selling_price_per_unit, moneyUnit)}</div>
    ${mk.wholesale_price ? `<div class="k">Bozordagi narx (ma'lumot uchun)</div><div class="v">${labNum(mk.wholesale_price, moneyUnit)}</div>` : ""}
  </div>

  ${next("Tanlangan liniya")}
  ${
    image
      ? `<div class="photo"><img src="${esc(image)}" alt="${esc(e.name)}" onerror="this.parentNode.style.display='none'"><div class="cap">Ishlab chiqaruvchi rasmi · ${esc(e.manufacturer.value)}, ${esc(e.model.value)}</div></div>`
      : ""
  }
  <div class="kv">
    <div class="k">Liniya</div><div class="v">${esc(e.name)}</div>
    <div class="k">Ishlab chiqaruvchi</div><div class="v">${lab(e.manufacturer)}</div>
    <div class="k">Model</div><div class="v">${lab(e.model)}</div>
    <div class="k">Narxi</div><div class="v">${labNum(e.price, money)}</div>
  </div>
  <div class="grid2">
    <div class="card"><div class="t">To'plamga kiradi</div><ul>${e.included.map((x) => `<li>${esc(x)}</li>`).join("") || "<li>Ma'lumot yo'q</li>"}</ul></div>
    <div class="card"><div class="t">Qo'shimcha kerak bo'lishi mumkin</div><ul>${e.additional_equipment.map((x) => `<li>${esc(x)}</li>`).join("") || "<li>Ma'lumot yo'q</li>"}</ul></div>
  </div>
</section>

<section class="page">
  ${next("Texnik ko'rsatkichlar")}
  <table><thead><tr><th style="width:45mm">Ko'rsatkich</th><th>Qiymat</th></tr></thead><tbody>
    <tr><td>Quvvat</td><td>${labNum(e.capacity_per_hour, (x) => `${num(x)} ${esc(unit)}/soat`)}</td></tr>
    <tr><td>Elektr quvvati</td><td>${labNum(e.power_kw, (x) => `${num(x)} kVt`)}</td></tr>
    <tr><td>Egallaydigan maydon</td><td>${labNum(e.area_m2, (x) => `${num(x)} m²`)}</td></tr>
    <tr><td>Operatorlar</td><td>${labNum(e.operators, (x) => `${num(x)} kishi`)}</td></tr>
    <tr><td>Og'irligi</td><td>${lab(e.weight)}</td></tr>
    <tr><td>Avtomatlashtirish</td><td>${lab(e.automation)}</td></tr>
    <tr><td>O'rnatish</td><td>${lab(e.installation)}</td></tr>
    <tr><td>Yetkazish muddati</td><td>${lab(e.lead_time)}</td></tr>
    <tr><td>Kafolat</td><td>${lab(e.warranty)}</td></tr>
  </tbody></table>

  <div class="block">
  ${next("Joy va infratuzilma")}
  <table><tbody>${data.facility.map((f) => `<tr><td style="width:45mm"><b>${esc(f.title)}</b></td><td>${esc(f.value)} ${badge(f.label)}${src(f.source)}</td></tr>`).join("")}</tbody></table>
  </div>
</section>

<section class="page">
  ${next("Xomashyo")}
  <table><thead><tr><th>Xomashyo</th><th>Spetsifikatsiya</th><th>Narx</th></tr></thead><tbody>
  ${e.raw_materials.map((r) => `<tr><td><b>${esc(r.name)}</b>${r.note ? `<span class="note">${esc(r.note)}</span>` : ""}</td><td>${esc(r.spec)}</td><td>${lab(r.price)}</td></tr>`).join("")}
  </tbody></table>

  <div class="block">
  ${next("Ishlab chiqarish jarayoni")}
  <ol class="steps">${data.process.map((s) => `<li><b>${esc(s.step)}.</b> ${esc(s.text)}</li>`).join("")}</ol>
  </div>
</section>

<section class="page">
  ${next("O'zbekiston bozori")}
  <p>${esc(mk.summary)}</p>
  ${mk.demand_indicators.length ? `<h3>Talab ko'rsatkichlari</h3><ul>${mk.demand_indicators.map((x) => `<li>${lab(x)}</li>`).join("")}</ul>` : ""}
  ${mk.imports_local ? `<h3>Import va mahalliy ishlab chiqarish</h3><p>${lab(mk.imports_local)}</p>` : ""}
  ${mk.competitors.length ? `<h3>Raqobatchilar</h3><table><tbody>${mk.competitors.map((c) => `<tr><td style="width:60mm"><b>${esc(c.name)}</b>${src(c.source)}</td><td>${esc(c.note)}</td></tr>`).join("")}</tbody></table>` : ""}
  <div class="grid2" style="margin-top:4mm">
    <div class="card"><div class="t">Xaridorlar</div><ul>${mk.customers.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    <div class="card"><div class="t">Sotuv kanallari</div>${esc(mk.distribution)}</div>
  </div>
  ${mk.risks.length ? `<h3>Bozor xavflari</h3><ul>${mk.risks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
  ${mk.limitations.length ? `<p class="small" style="margin-top:3mm"><b>Ma'lumot cheklovlari:</b> ${mk.limitations.map(esc).join("; ")}</p>` : ""}
</section>

<section class="page">
  ${next("Boshlang'ich investitsiya (CAPEX)")}
  ${moneyTable(model.capex.rows, money, "JAMI CAPEX", money(model.capex.total))}
  <p class="small" style="margin-top:2mm">${calcBadge} ${esc(model.capex.formula)}${model.capex.excluded.length ? `<br><b>Jami summaga kirmagan:</b> ${notIn(model.capex.excluded)} — summa noma'lum, haqiqiy investitsiya kattaroq bo'ladi.` : ""}</p>

  <div class="block">
  ${next("Oylik doimiy xarajatlar (OPEX)")}
  ${moneyTable(
    model.opex.rows,
    money,
    "JAMI OYLIK DOIMIY XARAJATLAR",
    money(model.opex.total),
    model.opex.electricity
      ? `<tr><td><b>Elektr energiya</b>${src(p.electricity_price_kwh?.source)}${calc(model.opex.electricity)}</td><td>${calcBadge}</td><td class="num">${money(model.opex.electricity.value!)}</td></tr>`
      : "",
  )}
  <p class="small" style="margin-top:2mm">${calcBadge} ${esc(model.opex.formula)}${model.opex.excluded.length ? `<br><b>Jami summaga kirmagan:</b> ${notIn(model.opex.excluded)} — summa noma'lum.` : ""}
  Bu xarajatlar ishlab chiqarish hajmiga bog'liq emas: yuklama past bo'lsa ham to'lanadi.</p>
  </div>
</section>

<section class="page">
  ${next("Ishlab chiqarish quvvati")}
  <div class="kv">
    <div class="k">Ish rejimi</div><div class="v">${num(p.hours_per_day)} soat/kun, ${p.shifts_per_day} smena, ${num(p.working_days_per_month)} ish kuni/oy ${badge(p.label)}${src(p.source)}</div>
    <div class="k">Yuklama (asosiy)</div><div class="v">${pct(p.utilization_base)} ${badge(p.label)}</div>
    <div class="k">Brak</div><div class="v">${num(p.scrap_pct)}% ${badge(p.label)}</div>
  </div>
  <table class="pnl"><thead><tr><th>Davr</th><th>Hisob</th><th class="num">Sifatli mahsulot</th></tr></thead><tbody>
    <tr><td><b>1 soat</b></td><td>${calc(model.capacity.per_hour_good)}</td><td class="num">${num(model.capacity.per_hour_good.value!)} ${esc(unit)}</td></tr>
    <tr><td><b>1 smena</b></td><td>${calc(model.capacity.per_shift)}</td><td class="num">${num(model.capacity.per_shift.value!)} ${esc(unit)}</td></tr>
    <tr><td><b>1 kun</b></td><td>${calc(model.capacity.per_day)}</td><td class="num">${num(model.capacity.per_day.value!)} ${esc(unit)}</td></tr>
    <tr class="res"><td><b>1 oy</b></td><td>${calc(model.capacity.per_month)}</td><td class="num">${num(model.month.units)} ${esc(unit)}</td></tr>
    <tr><td>Maksimum (100%)</td><td>${calc(model.capacity.max_month)}</td><td class="num">${num(model.capacity.max_month.value!)} ${esc(unit)}</td></tr>
  </tbody></table>
  <p class="small" style="margin-top:2mm">Nominal quvvat hech qachon 100% ishlatilmaydi: sozlash, qolip almashtirish, ta'mir va xomashyo kutish vaqtlari bor. Shuning uchun model yuklama va brak bilan hisoblaydi.</p>

  <div class="block">
  ${next(`Birlik iqtisodiyoti (1 ${esc(unit)})`)}
  <table class="pnl"><thead><tr><th>Ko'rsatkich</th><th class="num">1 ${esc(unit)}</th></tr></thead><tbody>
    ${model.variable.rows.map((r) => `<tr class="${r.included ? "" : "unknown"}"><td>${esc(r.title)} ${badge(r.label)}${src(r.source)}${r.note ? `<span class="note">${esc(r.note)}</span>` : ""}</td><td class="num">${r.included ? moneyUnit(r.amount!) : "noma'lum"}</td></tr>`).join("")}
    <tr class="res"><td>O'zgaruvchan xarajat (brak hisobga olingan)${calc(model.unit.variable)}</td><td class="num">${moneyUnit(model.unit.variable.value!)}</td></tr>
    ${model.revenue_costs.rows.length ? `<tr><td>Tushumdan to'lovlar: ${model.revenue_costs.rows.map((r) => `${esc(r.title)} ${r.included ? `${num(r.pct!)}%` : "noma'lum"} ${badge(r.label)}${src(r.source)}`).join(", ")}${calc(model.unit.revenue_costs)}</td><td class="num">${moneyUnit(model.unit.revenue_costs.value!)}</td></tr>` : ""}
    <tr><td>Doimiy xarajat ulushi${calc(model.unit.fixed)}</td><td class="num">${moneyUnit(model.unit.fixed.value!)}</td></tr>
    <tr class="res"><td>To'liq tannarx${calc(model.unit.cost)}</td><td class="num">${moneyUnit(model.unit.cost.value!)}</td></tr>
    <tr><td>Sotish narxi ${badge(mk.selling_price_per_unit.label)}${src(mk.selling_price_per_unit.source)}</td><td class="num">${moneyUnit(model.unit.price)}</td></tr>
    <tr><td>Marjinal daromad (narx − o'zgaruvchan xarajatlar)${calc(model.unit.contribution)}</td><td class="num${signedClass(model.unit.contribution.value)}">${moneyUnit(model.unit.contribution.value!)}</td></tr>
    <tr class="total"><td>Foyda (1 ${esc(unit)})</td><td class="num">${moneyUnit(model.unit.profit.value!)}</td></tr>
  </tbody></table>
  </div>
</section>

<section class="page">
  ${next("Tushum va foyda (oylik)")}
  <p>Tushum, yalpi foyda va operatsion foyda turli narsalar: quvvat × narx foyda emas.</p>
  <table class="pnl"><thead><tr><th>Qator</th><th class="num">Oyiga</th></tr></thead><tbody>
    <tr><td><b>Tushum (sotuvdan tushgan pul)</b>${calc(model.month.revenue)}</td><td class="num">${money(model.month.revenue.value!)}</td></tr>
    <tr class="minus"><td>− O'zgaruvchan xarajatlar (xomashyo, qadoq)${calc(model.month.variable_costs)}</td><td class="num">${money(model.month.variable_costs.value!)}</td></tr>
    ${model.revenue_costs.rows.length ? `<tr class="minus"><td>− Tushumdan to'lovlar (soliq va h.k.)${calc(model.month.revenue_costs)}</td><td class="num">${money(model.month.revenue_costs.value!)}</td></tr>` : ""}
    <tr class="res"><td><b>= Yalpi foyda</b>${calc(model.month.gross_profit)}</td><td class="num${signedClass(model.month.gross_profit.value)}">${moneySigned(model.month.gross_profit.value!)}</td></tr>
    <tr class="minus"><td>− Doimiy xarajatlar (ijara, ish haqi, elektr...)${calc(model.month.fixed_costs)}</td><td class="num">${money(model.month.fixed_costs.value!)}</td></tr>
    <tr class="total"><td>= OPERATSION FOYDA</td><td class="num">${moneySigned(op)}</td></tr>
  </tbody></table>
  <p class="small" style="margin-top:2mm">${calcBadge} Operatsion foyda: foyda solig'i, kredit foizlari va amortizatsiyadan oldin. Eng zaif ma'lumot darajasi: ${esc(model.weakest)}.</p>

  <div class="grid2" style="margin-top:4mm">
    <div class="card block">${next("Zararsizlik nuqtasi")}
      ${
        model.break_even.units.value === null
          ? `<p class="neg">${esc(model.break_even.reason)}</p>`
          : `<p>Oyiga kamida <b>${num(model.break_even.units.value)} ${esc(unit)}</b> sotish kerak (tushum ${money(model.break_even.revenue.value!)}), bu maksimal quvvatning <b>${num(model.break_even.utilization.value!)}%</b>.</p>
             ${calc(model.break_even.units)}${calc(model.break_even.revenue)}${calc(model.break_even.utilization)}`
      }
    </div>
    <div class="card block">${next("Qoplanish muddati")}
      ${
        model.payback.value === null
          ? `<p class="neg">${esc(model.payback.reason)}</p>${calc(model.payback)}`
          : `<p>CAPEX asosiy ssenariyda taxminan <b>${num(model.payback.value)} oyda</b> qoplanadi.</p>${calc(model.payback)}
             ${model.capex.excluded.length ? `<p class="small" style="margin-top:2mm">CAPEX'ga kirmagan xarajatlar bor: haqiqiy muddat uzunroq.</p>` : ""}`
      }
    </div>
  </div>
</section>

<section class="page">
  ${next("Ssenariylar")}
  <p>Bir xil narx va xarajatlar, faqat yuklama o'zgaradi. Doimiy xarajatlar har qanday yuklamada to'lanadi.</p>
  <table class="pnl"><thead><tr><th>Ko'rsatkich (oyiga)</th>${model.scenarios.map((s) => `<th class="num">${pct(s.utilization)}</th>`).join("")}</tr></thead><tbody>
    <tr><td>Ishlab chiqarish, ${esc(unit)}</td>${model.scenarios.map((s) => `<td class="num">${num(s.units)}</td>`).join("")}</tr>
    <tr><td>Tushum</td>${model.scenarios.map((s) => `<td class="num">${money(s.revenue)}</td>`).join("")}</tr>
    <tr class="minus"><td>− O'zgaruvchan xarajatlar</td>${model.scenarios.map((s) => `<td class="num">${money(s.variable_costs)}</td>`).join("")}</tr>
    ${model.revenue_costs.rows.length ? `<tr class="minus"><td>− Tushumdan to'lovlar</td>${model.scenarios.map((s) => `<td class="num">${money(s.revenue_costs)}</td>`).join("")}</tr>` : ""}
    <tr class="res"><td>= Yalpi foyda</td>${model.scenarios.map((s) => `<td class="num${signedClass(s.gross_profit)}">${moneySigned(s.gross_profit)}</td>`).join("")}</tr>
    <tr class="minus"><td>− Doimiy xarajatlar</td>${model.scenarios.map((s) => `<td class="num">${money(s.fixed_costs)}</td>`).join("")}</tr>
    <tr class="res"><td>= Operatsion foyda</td>${model.scenarios.map((s) => `<td class="num${signedClass(s.operating_profit)}">${moneySigned(s.operating_profit)}</td>`).join("")}</tr>
    <tr class="total"><td>Qoplanish muddati</td>${model.scenarios.map((s) => `<td class="num">${s.payback_months === null ? "yo'q" : `${num(s.payback_months)} oy`}</td>`).join("")}</tr>
  </tbody></table>
  <p class="small" style="margin-top:2mm">${calcBadge} Har bir ustun: quvvat × soat × kun × yuklama × (1 − brak) → tushum − o'zgaruvchan xarajatlar − doimiy xarajatlar. "yo'q" — operatsion foyda bo'lmagani uchun qoplanmaydi.</p>

  <div class="block">
  ${next("Xavflar")}
  <div class="pains">${data.risks.map((r, i) => `<div class="pain"><div class="pn">${String(i + 1).padStart(2, "0")}</div><div><div class="pt">${esc(r.title)}</div><div class="ps">${esc(r.text)}</div></div></div>`).join("")}</div>
  </div>
</section>

<section class="page">
  ${next("Investitsiyadan oldin nimani tekshirish kerak")}
  <ul class="check">${data.verify_before_investment.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
  ${
    model.capex.excluded.length + model.opex.excluded.length + model.variable.excluded.length
      ? `<h3>Modelda summasi noma'lum bo'lgan qatorlar</h3><ul class="check">${[...model.capex.excluded, ...model.opex.excluded, ...model.variable.excluded].map((r) => `<li>${esc(r.title)} ${badge("UNKNOWN")}</li>`).join("")}</ul>`
      : ""
  }
  <div class="callout"><b>Marketplace narxi rasmiy taklif emas.</b> Uskuna narxi, quvvati va to'plami ishlab chiqaruvchining yozma taklifi (quotation) va shartnomasi bilan tasdiqlanishi kerak. Zavodga tashrif yoki video-inspeksiya tavsiya etiladi.</div>
</section>

<section class="page">
  ${next(esc(content.services.title))}
  <p class="lead">${esc(content.services.intro)}</p>
  <div class="pains">${content.services.main.map((x, i) => `<div class="pain"><div class="pn">${String(i + 1).padStart(2, "0")}</div><div><div class="pt">${esc(x.title)}</div><div class="ps">${esc(x.text)}</div></div></div>`).join("")}</div>
  <h3>${esc(content.services.after_title)}</h3>
  <ul class="ok">${content.services.after.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
  <div class="cta">
    <h3>${esc(content.cta.title)}</h3>
    <div>${esc(content.cta.text)}</div>
    <span class="btn">🤝 @${esc(brand.botUsername)} → Muhokama qilmoqchiman</span>
  </div>
</section>

<section class="page">
  ${next("Manbalar va belgilar")}
  <table class="sources"><thead><tr><th>#</th><th>Manba</th><th>Turi</th><th>Olingan sana</th></tr></thead><tbody>
  ${data.sources.map((x) => `<tr><td>${x.id}</td><td>${esc(x.title)}<br><a>${esc(x.url)}</a></td><td>${esc(x.type)}</td><td class="num">${esc(x.retrieved_at)}</td></tr>`).join("")}
  </tbody></table>
  <h3>Belgilar nimani anglatadi</h3>
  <table class="legend"><tbody>${DATA_LABELS.map((l: DataLabel) => `<tr><td style="width:30mm">${badge(l)}</td><td>${LABEL_UZ[l]}</td></tr>`).join("")}</tbody></table>
  <p class="small" style="margin-top:4mm">Research sanasi: ${date}. <b>${DISCLAIMER}.</b> Model ochiq manbalar va farazlar asosida tuzilgan; narxlar, soliqlar va kurslar o'zgarishi mumkin. Qaror qabul qilishdan oldin barcha ma'lumotlarni rasmiy manbalardan va yetkazib beruvchilardan qayta tekshiring.</p>
</section>
</body></html>`;
}
