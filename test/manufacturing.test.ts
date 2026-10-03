import { describe, expect, it } from "vitest";
import example from "../src/ai/manufacturing-example.json";
import { manufacturingDiscoverPrompt, manufacturingPrompt } from "../src/ai/prompts-manufacturing";
import { DEFAULT_CONTENT } from "../src/pdf/content";
import { calculateManufacturing, moneyUnit, validateManufacturing, type ManufacturingResearch } from "../src/pdf/manufacturing";
import { manufacturingFooter, renderManufacturingHtml } from "../src/pdf/manufacturing-template";
import fixture from "./fixtures/manufacturing-research.json";

const research = () => structuredClone(fixture) as unknown as ManufacturingResearch;
const brand = { name: "abdulbosit_source", mark: "AS", botUsername: "test_bot" };

describe("manufacturing model", () => {
  it("computes capacity, unit economics, profit, break-even and payback (hand-checked)", () => {
    const m = calculateManufacturing(research());
    // 5 000/h × 70% × (1 − 2%) = 3 430 good units/h
    expect(m.capacity.per_hour_good.value).toBe(3430);
    expect(m.capacity.per_shift.value).toBe(27_440); // × 8 h
    expect(m.capacity.per_day.value).toBe(54_880); // × 16 h
    expect(m.month.units).toBe(1_372_000); // × 25 days
    expect(m.capacity.per_month.formula).toBe("5 000 dona/soat × 16 soat × 25 kun × 70% × (1 − 2%) = 1 372 000 dona");
    expect(m.capacity.max_month.value).toBe(1_960_000);

    // CAPEX 38 000 + 3 000 + 5 600 + 1 500 + 5 000; renovation is UNKNOWN
    expect(m.capex.total).toBe(53_100);
    expect(m.capex.excluded.map((r) => r.key)).toEqual(["renovation"]);
    // Fixed: 800 + 2 400 + 200 + 300 + electricity 15 kW × 16 h × 25 d × $0.08 = 480
    expect(m.opex.electricity!.value).toBe(480);
    expect(m.opex.total).toBe(4180);
    expect(m.opex.excluded.map((r) => r.key)).toEqual(["certification"]);

    // Variable: 0.0145 per produced unit → / 0.98 per good unit
    expect(m.variable.per_produced_unit).toBe(0.0145);
    expect(m.unit.variable.value).toBeCloseTo(0.014796, 6);
    expect(m.unit.revenue_costs.value).toBeCloseTo(0.00088, 6); // 4% × $0.022
    expect(m.unit.fixed.value).toBeCloseTo(4180 / 1_372_000, 6);
    expect(m.unit.cost.value).toBeCloseTo(0.018723, 6);
    expect(m.unit.contribution.value).toBeCloseTo(0.006324, 6);

    // Revenue → gross → operating, never capacity × price
    expect(m.month.revenue.value).toBe(30_184); // 1 372 000 × 0.022
    expect(m.month.variable_costs.value).toBe(20_300); // 1 400 000 produced × 0.0145
    expect(m.month.revenue_costs.value).toBe(1207); // 4% of revenue
    expect(m.month.gross_profit.value).toBe(8677);
    expect(m.month.operating_profit.value).toBe(4497);
    expect(m.month.margin_pct).toBe(14.9);

    // Break-even: 4 180 ÷ 0.0063241 = 660 966 units
    expect(m.break_even.units.value).toBe(660_966);
    expect(m.break_even.revenue.value).toBe(14_541);
    expect(m.break_even.utilization.value).toBe(33.7);
    // Payback: 53 100 ÷ 4 496.64 = 11.8 months
    expect(m.payback.value).toBe(11.8);
    expect(m.payback.formula).toBe("$53 100 ÷ $4 497/oy = 11.8 oy");

    expect(m.scenarios.map((s) => [s.utilization, s.units, s.revenue, s.operating_profit, s.payback_months])).toEqual([
      [0.5, 980_000, 21_560, 2018, 26.3],
      [0.7, 1_372_000, 30_184, 4497, 11.8],
      [0.9, 1_764_000, 38_808, 6976, 7.6],
    ]);
    expect(m.weakest).toBe("ASSUMPTION");
    expect(m.warnings.join(" ")).toContain("CAPEX to'liq emas");
  });

  it("uses default scenarios when none are given and ignores UNKNOWN inputs", () => {
    const data = research();
    delete data.scenarios;
    data.variable_costs.push({ key: "glue", title: "Yelim", amount: null, label: "UNKNOWN", source: null });
    const m = calculateManufacturing(data);
    expect(m.scenarios.map((s) => s.utilization)).toEqual([0.5, 0.7, 0.9]);
    expect(m.variable.per_produced_unit).toBe(0.0145);
    expect(m.variable.excluded.map((r) => r.key)).toEqual(["glue"]);
  });

  it("a loss-making case has no break-even and no payback, and says so", () => {
    const data = research();
    data.market.selling_price_per_unit.value = 0.015; // below variable cost per unit
    const m = calculateManufacturing(data);
    expect(m.month.operating_profit.value).toBeLessThan(0);
    expect(m.break_even.units.value).toBeNull();
    expect(m.payback.value).toBeNull();
    expect(m.payback.reason).toContain("qoplanish muddati hisoblanmaydi");
    expect(m.scenarios.every((s) => s.payback_months === null)).toBe(true);
    const html = renderManufacturingHtml(data, m, brand, DEFAULT_CONTENT);
    expect(html).toContain("hisoblanmaydi");
  });

  it("positive contribution but too little volume: break-even exists, payback does not", () => {
    const data = research();
    data.production.utilization_base = 0.2;
    const m = calculateManufacturing(data);
    expect(m.break_even.units.value).toBe(660_966);
    expect(m.month.operating_profit.value).toBeLessThan(0);
    expect(m.payback.value).toBeNull();
  });

  it("formats per-unit money with enough precision", () => {
    expect(moneyUnit(0.022)).toBe("$0.022");
    expect(moneyUnit(0.00088)).toBe("$0.00088");
    expect(moneyUnit(0.0147959)).toBe("$0.0148");
    expect(moneyUnit(12.5)).toBe("$12.50");
    expect(moneyUnit(0)).toBe("$0.00");
  });
});

describe("manufacturing validation", () => {
  it("accepts the fixture and the prompt example", () => {
    expect(validateManufacturing(research())).toMatchObject({ ok: true });
    expect(validateManufacturing(example)).toMatchObject({ ok: true });
  });

  it("rejects UNKNOWN with a number, dangling sources, bad image URL, CALCULATED inputs and missing capacity", () => {
    const data = research() as unknown as Record<string, any>;
    data.capex[5].amount = 1000; // renovation is UNKNOWN
    data.opex_monthly[0].source = 99;
    data.equipment.image_url = "http://example.com/page.html";
    data.variable_costs[0].label = "CALCULATED";
    data.equipment.capacity_per_hour = { value: null, label: "UNKNOWN", source: null };
    data.market.selling_price_per_unit.label = "ESTIMATED";
    data.market.selling_price_per_unit.value = null;
    data.highlights = ["one"];
    data.post_stats = [{ label: "x", value: "1", source: null }];
    data.production.utilization_base = 70;
    const result = validateManufacturing(data);
    expect(result.ok).toBe(false);
    const errors = (result as { errors: string[] }).errors.join("\n");
    expect(errors).toContain("capex[5] (renovation): у UNKNOWN amount должен быть null");
    expect(errors).toContain("opex_monthly[0] (rent): источник [99]");
    expect(errors).toContain("equipment.image_url");
    expect(errors).toContain("variable_costs[0] (paper).label");
    expect(errors).toContain("equipment.capacity_per_hour: без этого значения модель не считается");
    expect(errors).toContain("market.selling_price_per_unit: null допустим только с меткой UNKNOWN");
    expect(errors).toContain("highlights: от 2 до 4 строк");
    expect(errors).toContain("post_stats[0]: цифры для поста нужны с источником");
    expect(errors).toContain("production.utilization_base");
  });

  it("rejects something that is not a package at all", () => {
    expect(validateManufacturing([1, 2])).toMatchObject({ ok: false });
    expect(validateManufacturing(null)).toMatchObject({ ok: false });
    const bad = validateManufacturing({ slug: "Bad Slug" });
    expect(bad.ok).toBe(false);
    expect((bad as { errors: string[] }).errors).toContain("slug: латиница, цифры и дефис, 2–40 символов");
  });
});

describe("manufacturing PDF template", () => {
  const data = research();
  const model = calculateManufacturing(data);
  const html = renderManufacturingHtml(data, model, brand, DEFAULT_CONTENT);

  it("contains every section, the numbers and the disclaimer", () => {
    for (const section of [
      "Qisqacha xulosa",
      "Mahsulot",
      "Tanlangan liniya",
      "Texnik ko'rsatkichlar",
      "Joy va infratuzilma",
      "Xomashyo",
      "Ishlab chiqarish jarayoni",
      "O'zbekiston bozori",
      "Boshlang'ich investitsiya (CAPEX)",
      "Oylik doimiy xarajatlar (OPEX)",
      "Ishlab chiqarish quvvati",
      "Birlik iqtisodiyoti",
      "Tushum va foyda",
      "Yalpi foyda",
      "OPERATSION FOYDA",
      "Zararsizlik nuqtasi",
      "Qoplanish muddati",
      "Ssenariylar",
      "Xavflar",
      "Investitsiyadan oldin nimani tekshirish kerak",
      "Manbalar va belgilar",
      DEFAULT_CONTENT.services.title,
    ]) {
      expect(html, section).toContain(section);
    }
    expect(html).toContain("$53 100");
    expect(html).toContain("$4 497");
    expect(html).toContain("11.8 oy");
    expect(html).toContain("Dastlabki model, investitsiya kafolati emas");
    expect(html).toContain("Ishlab chiqaruvchi rasmi");
    expect(html).toContain('src="https://www.example-machines.cn/images/zb-12-paper-cup.jpg"');
    expect(html).toContain("onerror=");
    expect(html).toContain("NAMUNA");
    expect(html).toContain("@test_bot");
    expect(html).not.toMatch(/\$ ___|kuniga|Tayyorgarlik paketi|NaN|undefined/);
  });

  it("hides the photo without image_url or when overridden with null, and drops NAMUNA for real packages", () => {
    const real = research();
    delete real.sample;
    delete real.equipment.image_url;
    const out = renderManufacturingHtml(real, calculateManufacturing(real), brand, DEFAULT_CONTENT);
    expect(out).not.toContain("NAMUNA");
    expect(out).not.toContain("Ishlab chiqaruvchi rasmi");
    expect(renderManufacturingHtml(data, model, brand, DEFAULT_CONTENT, { imageSrc: null })).not.toContain("<img");
    expect(renderManufacturingHtml(data, model, brand, DEFAULT_CONTENT, { imageSrc: "data:image/png;base64,AAAA" })).toContain(
      'src="data:image/png;base64,AAAA"',
    );
  });

  it("footer names the product and the research date", () => {
    expect(manufacturingFooter(brand, data)).toContain("Qog'oz stakan ishlab chiqarish · research 2026-10-03");
  });
});

describe("manufacturing prompts", () => {
  it("discovery reuses the exhibition candidate shape", () => {
    const p = manufacturingDiscoverPrompt("2026-10-03", "qadoqlash", ["Qog'oz stakan"]);
    expect(p).toContain('"candidates"');
    expect(p).toContain("official_site");
    expect(p).toContain("qadoqlash");
    expect(p).toContain("Qog'oz stakan");
  });

  it("research prompt carries the target, the rules and the example", () => {
    const p = manufacturingPrompt("2026-10-03", {
      name: "Qog'oz stakan", edition: "", full_name: "ZB-12", city: "O'zbekiston", dates: "", industry: "qadoqlash",
      official_site: "https://example.com", why: "Talab bor", source_url: "https://example.com/zb-12",
    });
    expect(p).toContain("ZB-12");
    expect(p).toContain("https://example.com/zb-12");
    expect(p).toContain("CALCULATED не используй");
    expect(p).toContain("egg-tray-line-example");
    expect(manufacturingPrompt("2026-10-03", "tuxum taglik")).toContain("«tuxum taglik»");
  });
});
