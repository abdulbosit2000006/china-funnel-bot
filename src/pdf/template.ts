import { FONT_CSS } from "./fonts.generated";
import { DATA_LABELS, type Budget, type DataLabel, type ExhibitionResearch, money } from "./exhibition";

export interface Brand {
  name: string;
  mark: string;
  botUsername: string;
}

/** Our own copy (services, CTA). Kept apart from research so the AI never writes what we sell. */
export interface BrandContent {
  services: { title: string; intro: string; main: { title: string; text: string }[]; after_title: string; after: string[] };
  cta: { title: string; text: string };
}

const LABEL_UZ: Record<DataLabel, string> = {
  VERIFIED: "Rasmiy manba bilan tasdiqlangan",
  "MARKET DATA": "Bozor / soha manbasidan",
  ASSUMPTION: "Bizning farazimiz",
  CALCULATED: "Formula bo'yicha hisoblangan",
  ESTIMATED: "Taxminiy baho",
  UNKNOWN: "Ma'lumot yetarli emas, tekshirilishi kerak",
};

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const badge = (label: string) => `<span class="badge b-${label.replace(" ", "-").toLowerCase()}">${label}</span>`;
const src = (id: number | null | undefined) => (id ? `<sup class="src">[${id}]</sup>` : "");
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
export const fmtDate = (iso: string) => {
  const [y, mo, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[mo! - 1]} ${y}`;
};

export function footerTemplate(brand: Brand, data: ExhibitionResearch): string {
  return `<div style="width:100%;font-size:7pt;color:#8a94a3;padding:0 15mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>${esc(brand.name)} · ${esc(data.exhibition.name)} · research ${esc(data.research_date)}</span><span class="pageNumber"></span></div>`;
}

export function renderExhibitionHtml(data: ExhibitionResearch, budget: Budget, brand: Brand, content: BrandContent): string {
  const e = data.exhibition;
  const s = data.scenario;
  const date = fmtDate(data.research_date);
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
td .note{display:block;color:var(--muted);font-size:8.2pt;margin-top:.5mm}
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
</style></head><body>
${data.sample ? `<div class="watermark">NAMUNA</div>` : ""}

<section class="page cover">
  <div class="deco"></div>
  ${data.sample ? `<div class="samplebar">NAMUNA: SHABLON KO'RINISHI. RAQAM VA SANALAR TEKSHIRILMAGAN</div>` : ""}
  <div class="top"><div class="logo"><span class="mark">${esc(brand.mark)}</span>${esc(brand.name)}</div><div>Biznes safar qo'llanmasi</div></div>
  <div class="kicker">Ko'rgazma · ${esc(e.city)}, Xitoy</div>
  <h1>${esc(e.name)}<br>biznes safari</h1>
  <div class="sub">2 kishi uchun namunaviy safar byudjeti va amaliy qo'llanma</div>
  <div class="facts">
    <div class="fact"><div class="k">Ko'rgazma sanalari</div><div class="v">${esc(e.dates.value)}</div></div>
    <div class="fact"><div class="k">Tavsiya etilgan safar</div><div class="v">${esc(s.trip_dates)}</div></div>
    <div class="fact"><div class="k">Yo'nalish</div><div class="v">${esc(s.route)}</div></div>
    <div class="fact"><div class="k">Mehmonxona</div><div class="v">${esc(s.hotel_short ?? s.hotel_category)}</div></div>
  </div>
  <div class="total">
    <div><div class="k">Jami taxminiy byudjet · 2 kishi</div><div class="v">${money(budget.total)}</div></div>
    <div class="pp">1 kishiga<b>${money(budget.perPerson)}</b></div>
  </div>
  <div class="foot">
    Research sanasi: <b>${date}</b>. Narxlar taxminiy va ${date} holatiga ko'ra; aviachipta va mehmonxona narxlari o'zgarishi mumkin.
  </div>
</section>

<section class="page">
  <h2><span class="n">01</span>Ko'rgazma haqida</h2>
  <div class="kv">
    <div class="k">To'liq nomi</div><div class="v">${esc(e.full_name)}</div>
    <div class="k">Rasmiy sayt</div><div class="v">${esc(e.official_site)}</div>
    <div class="k">Tashkilotchi</div><div class="v">${esc(e.organizer)}</div>
    <div class="k">O'tkaziladigan joy</div><div class="v">${esc(e.venue)}</div>
    <div class="k">Sanalar</div><div class="v">${esc(e.dates.value)} ${badge(e.dates.label)}${src(e.dates.source)}</div>
  </div>
  <h3>Bosqichlar va kategoriyalar</h3>
  <table><thead><tr><th>Bosqich</th><th>Sanalar</th><th>Asosiy kategoriyalar</th></tr></thead><tbody>
  ${e.phases.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.name === e.focus_phase ? ` <span class="badge b-verified" style="background:var(--accent-soft);color:var(--accent-ink)">BIZ TAVSIYA QILAMIZ</span>` : ""}</td><td class="num" style="text-align:left">${esc(p.dates)}</td><td>${esc(p.categories)}</td></tr>`).join("")}
  </tbody></table>
  <h3>Nega bu O'zbekiston tadbirkori uchun muhim</h3>
  <ul>${e.relevance.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
  <div class="grid2" style="margin-top:5mm">
    <div class="card"><div class="t">Tashrif buyuruvchilar uchun</div>${esc(e.visitor_info.value)} ${badge(e.visitor_info.label)}${src(e.visitor_info.source)}</div>
    <div class="card"><div class="t">Ro'yxatdan o'tish</div>${esc(e.registration.value)} ${badge(e.registration.label)}${src(e.registration.source)}</div>
  </div>
</section>

<section class="page">
  <h2><span class="n">02</span>Safar byudjeti: 2 kishi uchun hisob-kitob</h2>
  <div class="callout"><b>2 kishi uchun namunaviy hisob-kitob.</b> Bu standart ssenariy: har bir mijoz uchun alohida hisob emas.
  Narxlar taxminiy va <b>${date}</b> holatiga ko'ra. Aviachipta va mehmonxona narxlari o'zgarishi mumkin.</div>
  <div class="kv">
    <div class="k">Kishilar soni</div><div class="v">${s.people}</div>
    <div class="k">Yo'nalish</div><div class="v">${esc(s.route)}</div>
    <div class="k">Safar sanalari</div><div class="v">${esc(s.trip_dates)} (${s.nights} kecha, ${s.days} kun)</div>
    <div class="k">Mehmonxona</div><div class="v">${esc(s.hotel_category)}, ${s.rooms} xona</div>
  </div>
  <table><thead><tr><th>Xarajat</th><th>Hisob</th><th>Belgi</th><th class="num">Summa</th></tr></thead><tbody>
  ${budget.rows.map((r) => `<tr class="${r.amount === null ? "unknown" : ""}"><td><b>${esc(r.title)}</b>${src(r.source)}${r.note ? `<span class="note">${esc(r.note)}</span>` : ""}</td><td>${esc(r.formula)}</td><td>${badge(r.label)}</td><td class="num">${r.amount === null ? "noma'lum" : money(r.amount)}</td></tr>`).join("")}
  <tr class="sum"><td colspan="3">Oraliq jami</td><td class="num">${money(budget.subtotal)}</td></tr>
  <tr><td><b>Kutilmagan xarajatlar uchun zaxira</b></td><td>${data.reserve_pct}% × ${money(budget.subtotal)}</td><td>${badge("CALCULATED")}</td><td class="num">${money(budget.reserve)}</td></tr>
  <tr class="total"><td colspan="3">JAMI TAXMINIY BYUDJET (2 kishi)</td><td class="num">${money(budget.total)}</td></tr>
  </tbody></table>
  <p class="small" style="margin-top:3mm">Jami: ${badge("CALCULATED")} — ${esc(budget.weakest)} ma'lumotlar asosida hisoblangan. 1 kishiga: <b>${money(budget.perPerson)}</b>.
  ${budget.excluded.length ? `<br><b>Jami summaga kirmagan:</b> ${budget.excluded.map((r) => esc(r.title)).join(", ")} — ma'lumot hali tasdiqlanmagan.` : ""}</p>
</section>

<section class="page">
  <h2><span class="n">03</span>Safar dasturi</h2>
  <table class="prog"><tbody>${data.program.map((p) => `<tr><td>${esc(p.day)}</td><td>${esc(p.text)}</td></tr>`).join("")}</tbody></table>
  <h3>Tayyorgarlik ro'yxati</h3>
  <ul class="check">${data.checklist.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
  <h3>Foydali amaliy ma'lumotlar</h3>
  <div class="grid2">${data.practical.map((p) => `<div class="card"><div class="t">${esc(p.title)}</div>${esc(p.text)}</div>`).join("")}</div>
</section>

<section class="page">
  <h2><span class="n">04</span>${esc(content.services.title)}</h2>
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
  <h2><span class="n">05</span>Manbalar va belgilar</h2>
  
  <table class="sources"><thead><tr><th>#</th><th>Manba</th><th>Turi</th><th>Olingan sana</th></tr></thead><tbody>
  ${data.sources.map((x) => `<tr><td>${x.id}</td><td>${esc(x.title)}<br><a>${esc(x.url)}</a></td><td>${esc(x.type)}</td><td class="num">${esc(x.retrieved_at)}</td></tr>`).join("")}
  </tbody></table>
  <h3>Belgilar nimani anglatadi</h3>
  <table class="legend"><tbody>${DATA_LABELS.map((l) => `<tr><td style="width:30mm">${badge(l)}</td><td>${LABEL_UZ[l]}</td></tr>`).join("")}</tbody></table>
  <p class="small" style="margin-top:4mm">Research sanasi: ${date}. Ushbu qo'llanma ma'lumot uchun; narxlar va sanalar o'zgarishi mumkin, rasmiy manbalardan qayta tekshiring.</p>
</section>
</body></html>`;
}
