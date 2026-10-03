// Production business idea: research data -> deterministic financial model.
// The model (or a person) supplies labeled inputs with sources; every derived number in the PDF is computed here.
import { DATA_LABELS, SOURCE_TYPES, money, type DataLabel, type Labeled } from "./exhibition";

/** A numeric input. null = not found; such a value is shown but never used in totals. */
export interface LabeledNumber {
  value: number | null;
  label: DataLabel;
  source: number | null;
  note?: string;
}

/** A money row of the model (CAPEX item, monthly cost, cost per unit). */
export interface MoneyInput {
  key: string;
  title: string;
  /** USD. null = not found: listed, excluded from totals. Per-unit rows may have fractions of a cent. */
  amount: number | null;
  label: DataLabel;
  source: number | null;
  note?: string;
}

/** A cost taken as a share of revenue (turnover tax, distributor commission). */
export interface PercentInput {
  key: string;
  title: string;
  /** Percent of revenue, e.g. 4 = 4%. null = unknown, excluded. */
  pct: number | null;
  label: DataLabel;
  source: number | null;
  note?: string;
}

export interface Source {
  id: number;
  title: string;
  url: string;
  type: string;
  retrieved_at: string;
}

export interface ManufacturingResearch {
  slug: string;
  title: string;
  sample?: boolean;
  research_date: string; // YYYY-MM-DD
  currency: "USD";
  product: {
    name: string;
    /** One line in Uzbek: what the business is. Used in the channel post. */
    tagline: string;
    description: string;
    /** Unit word in Uzbek for all per-unit numbers: "dona", "kg", "m²"... */
    unit: string;
  };
  equipment: {
    name: string;
    manufacturer: Labeled;
    model: Labeled;
    /** https direct JPG/PNG of this exact machine from the manufacturer or marketplace page. Never an AI image. */
    image_url?: string;
    price: LabeledNumber;
    /** Nominal output, product units per hour. */
    capacity_per_hour: LabeledNumber;
    power_kw: LabeledNumber;
    area_m2: LabeledNumber;
    operators: LabeledNumber;
    weight: Labeled;
    automation: Labeled;
    included: string[];
    additional_equipment: string[];
    installation: Labeled;
    lead_time: Labeled;
    warranty: Labeled;
    raw_materials: { name: string; spec: string; price: Labeled; note?: string }[];
  };
  /** 2–4 bullets in Uzbek: why this is interesting for an Uzbek entrepreneur. */
  highlights: string[];
  /** Verified metrics for the channel post. Every item needs a source. */
  post_stats?: { label: string; value: string; source: number }[];
  market: {
    summary: string;
    /** Price the producer receives per unit (B2B / wholesale to shops and distributors). Drives the model. */
    selling_price_per_unit: LabeledNumber;
    /** Optional reference: observed wholesale/retail price on the market, per unit. Not used in the model. */
    wholesale_price?: LabeledNumber;
    demand_indicators: Labeled[];
    competitors: { name: string; note: string; source: number | null }[];
    imports_local?: Labeled;
    customers: string[];
    distribution: string;
    risks: string[];
    limitations: string[];
  };
  capex: MoneyInput[];
  /** Monthly costs that do not depend on output: rent, salaries, maintenance... (electricity is computed, see production). */
  opex_monthly: MoneyInput[];
  /** Costs per produced unit (raw material, packaging, ink...). Scrap is accounted for by the model. */
  variable_costs: MoneyInput[];
  /** Optional costs as % of revenue (turnover tax, commission). */
  revenue_costs?: PercentInput[];
  production: {
    hours_per_day: number;
    shifts_per_day: number;
    working_days_per_month: number;
    /** Share of nominal capacity actually used in the base case, 0–1. */
    utilization_base: number;
    /** Defective output, percent of produced units. */
    scrap_pct: number;
    /** USD per kWh; with equipment.power_kw the model computes the monthly electricity cost. */
    electricity_price_kwh?: LabeledNumber;
    label: DataLabel;
    source: number | null;
    note?: string;
  };
  /** Utilization levels for the scenario table; default [0.5, 0.7, 0.9]. */
  scenarios?: number[];
  process: { step: string; text: string }[];
  facility: { title: string; value: string; label: DataLabel; source: number | null }[];
  risks: { title: string; text: string }[];
  verify_before_investment: string[];
  sources: Source[];
}

/** A computed number with its trace: inputs → formula → result. */
export interface Calc {
  value: number | null;
  formula: string;
}

export interface MoneyRow extends MoneyInput {
  /** True when the row is in the total. */
  included: boolean;
}

export interface ScenarioRow {
  utilization: number;
  units: number;
  revenue: number;
  variable_costs: number;
  revenue_costs: number;
  gross_profit: number;
  fixed_costs: number;
  operating_profit: number;
  payback_months: number | null;
}

export interface ManufacturingModel {
  capex: { rows: MoneyRow[]; total: number; excluded: MoneyRow[]; formula: string };
  opex: { rows: MoneyRow[]; total: number; excluded: MoneyRow[]; formula: string; electricity: Calc | null };
  variable: { rows: MoneyRow[]; excluded: MoneyRow[]; per_produced_unit: number; per_good_unit: Calc };
  revenue_costs: { rows: (PercentInput & { included: boolean })[]; pct: number };
  capacity: {
    per_hour_nominal: number;
    per_hour_good: Calc;
    per_shift: Calc;
    per_day: Calc;
    per_month: Calc;
    /** Good units per month at 100% utilization. */
    max_month: Calc;
  };
  unit: {
    price: number;
    variable: Calc;
    revenue_costs: Calc;
    fixed: Calc;
    cost: Calc;
    contribution: Calc;
    profit: Calc;
  };
  month: {
    units: number;
    revenue: Calc;
    variable_costs: Calc;
    revenue_costs: Calc;
    gross_profit: Calc;
    fixed_costs: Calc;
    operating_profit: Calc;
    /** Operating profit / revenue, percent (1 decimal). */
    margin_pct: number | null;
  };
  break_even: { units: Calc; revenue: Calc; utilization: Calc; reason?: string };
  payback: Calc & { reason?: string };
  scenarios: ScenarioRow[];
  /** Weakest label among the inputs that made it into the numbers. */
  weakest: DataLabel;
  /** Uzbek warnings for the reader (incomplete totals, loss, etc.). */
  warnings: string[];
}

export const DEFAULT_SCENARIOS = [0.5, 0.7, 0.9];

const round = (x: number) => Math.round(x);
/** Per-unit money keeps 6 decimals: a paper cup costs fractions of a cent. */
const round4 = (x: number) => Math.round(x * 1_000_000) / 1_000_000;
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Whole dollars with sign: "−$1 200". */
export function moneySigned(x: number): string {
  return x < 0 ? "−" + money(-x) : money(x);
}

/** Per-unit price: cents, or 4 significant digits below $1 ($0.0148, $0.00088). */
export function moneyUnit(x: number): string {
  const sign = x < 0 ? "−" : "";
  const a = Math.abs(x);
  let s = a >= 1 ? a.toFixed(2) : a === 0 ? "0.00" : Number(a.toPrecision(4)).toFixed(8).replace(/0+$/, "");
  while (s.split(".")[1]!.length < 2) s += "0";
  const [int, frac] = s.split(".");
  return `${sign}$${Number(int).toLocaleString("en-US").replace(/,/g, " ")}${frac ? "." + frac : ""}`;
}

export function num(x: number): string {
  return x.toLocaleString("en-US", { maximumFractionDigits: 1 }).replace(/,/g, " ");
}

export const pct = (x: number) => `${num(round1(x * 100))}%`;

const isKnown = (x: { label: DataLabel }, v: number | null) => v !== null && x.label !== "UNKNOWN";
const weaker = (a: DataLabel, b: DataLabel) => (DATA_LABELS.indexOf(b) > DATA_LABELS.indexOf(a) ? b : a);

export function calculateManufacturing(data: ManufacturingResearch): ManufacturingModel {
  const p = data.production;
  const unit = data.product.unit;
  const warnings: string[] = [];
  let weakest: DataLabel = "VERIFIED";
  const use = (label: DataLabel) => void (weakest = weaker(weakest, label));

  const moneyRows = (items: MoneyInput[]): MoneyRow[] =>
    items.map((it) => {
      const included = isKnown(it, it.amount);
      if (included) use(it.label);
      return { ...it, included };
    });
  const sum = (rows: MoneyRow[]) => rows.reduce((acc, r) => acc + (r.included ? r.amount! : 0), 0);
  const listSum = (rows: MoneyRow[], fmt: (x: number) => string) =>
    rows.filter((r) => r.included).map((r) => fmt(r.amount!)).join(" + ") || "0";

  // CAPEX
  const capexRows = moneyRows(data.capex);
  const capexTotal = round(sum(capexRows));
  const capexExcluded = capexRows.filter((r) => !r.included);
  if (capexExcluded.length)
    warnings.push(
      `CAPEX to'liq emas: ${capexExcluded.map((r) => r.title).join(", ")} summasi noma'lum, jami summaga kirmagan. Haqiqiy investitsiya va qoplanish muddati kattaroq bo'ladi.`,
    );

  // Production capacity
  const cap = data.equipment.capacity_per_hour.value!;
  use(data.equipment.capacity_per_hour.label);
  use(p.label);
  const good = 1 - p.scrap_pct / 100;
  const hoursPerShift = p.hours_per_day / p.shifts_per_day;
  const goodPerHour = cap * p.utilization_base * good;
  const unitsMonthExact = goodPerHour * p.hours_per_day * p.working_days_per_month;
  const unitsMonth = round(unitsMonthExact);
  const maxMonth = round(cap * good * p.hours_per_day * p.working_days_per_month);
  const capTxt = `${num(cap)} ${unit}/soat`;
  const capacity: ManufacturingModel["capacity"] = {
    per_hour_nominal: cap,
    per_hour_good: {
      value: round1(goodPerHour),
      formula: `${capTxt} × ${pct(p.utilization_base)} yuklama × (1 − ${num(p.scrap_pct)}% brak) = ${num(round1(goodPerHour))} ${unit}/soat`,
    },
    per_shift: {
      value: round(goodPerHour * hoursPerShift),
      formula: `${num(round1(goodPerHour))} ${unit}/soat × ${num(hoursPerShift)} soat = ${num(round(goodPerHour * hoursPerShift))} ${unit}`,
    },
    per_day: {
      value: round(goodPerHour * p.hours_per_day),
      formula: `${num(round1(goodPerHour))} ${unit}/soat × ${num(p.hours_per_day)} soat (${p.shifts_per_day} smena) = ${num(round(goodPerHour * p.hours_per_day))} ${unit}`,
    },
    per_month: {
      value: unitsMonth,
      formula: `${capTxt} × ${num(p.hours_per_day)} soat × ${num(p.working_days_per_month)} kun × ${pct(p.utilization_base)} × (1 − ${num(p.scrap_pct)}%) = ${num(unitsMonth)} ${unit}`,
    },
    max_month: {
      value: maxMonth,
      formula: `${capTxt} × ${num(p.hours_per_day)} soat × ${num(p.working_days_per_month)} kun × 100% × (1 − ${num(p.scrap_pct)}%) = ${num(maxMonth)} ${unit}`,
    },
  };

  // Monthly fixed costs (+ computed electricity)
  const opexRows = moneyRows(data.opex_monthly);
  let electricity: Calc | null = null;
  let electricityAmount = 0;
  const kw = data.equipment.power_kw;
  const tariff = p.electricity_price_kwh;
  if (tariff) {
    if (isKnown(kw, kw.value) && isKnown(tariff, tariff.value)) {
      use(kw.label);
      use(tariff.label);
      const kwh = kw.value! * p.hours_per_day * p.working_days_per_month;
      electricityAmount = round(kwh * tariff.value!);
      electricity = {
        value: electricityAmount,
        formula: `${num(kw.value!)} kVt × ${num(p.hours_per_day)} soat × ${num(p.working_days_per_month)} kun = ${num(kwh)} kVt·soat × ${moneyUnit(tariff.value!)} = ${money(electricityAmount)}`,
      };
    } else {
      warnings.push("Elektr energiya xarajati hisoblanmadi: uskuna quvvati yoki tarif noma'lum.");
    }
  }
  const opexTotal = round(sum(opexRows)) + electricityAmount;
  const opexExcluded = opexRows.filter((r) => !r.included);
  if (opexExcluded.length)
    warnings.push(`Oylik xarajatlarga kirmagan (summa noma'lum): ${opexExcluded.map((r) => r.title).join(", ")}.`);
  const opexFormula = `${[listSum(opexRows, money), ...(electricity ? [money(electricityAmount)] : [])].join(" + ")} = ${money(opexTotal)}`;

  // Variable costs per unit
  const varRows = moneyRows(data.variable_costs);
  const varProduced = sum(varRows);
  const varGood = varProduced / good;
  const varExcluded = varRows.filter((r) => !r.included);
  if (varExcluded.length)
    warnings.push(`1 ${unit} tannarxiga kirmagan (narx noma'lum): ${varExcluded.map((r) => r.title).join(", ")}. Haqiqiy tannarx yuqoriroq bo'ladi.`);

  // Revenue-linked costs
  const rcRows = (data.revenue_costs ?? []).map((it) => {
    const included = isKnown(it, it.pct);
    if (included) use(it.label);
    return { ...it, included };
  });
  const rcPct = rcRows.reduce((acc, r) => acc + (r.included ? r.pct! : 0), 0);

  // Unit economics
  const price = data.market.selling_price_per_unit.value!;
  use(data.market.selling_price_per_unit.label);
  const rcUnit = (price * rcPct) / 100;
  const fixedUnit = unitsMonth > 0 ? opexTotal / unitsMonth : 0;
  const contribution = price - varGood - rcUnit;
  const unitCost = varGood + rcUnit + fixedUnit;
  const u = (x: number) => moneyUnit(round4(x));
  const unitEcon: ManufacturingModel["unit"] = {
    price,
    variable: {
      value: round4(varGood),
      formula: `${u(varProduced)} (${listSum(varRows, moneyUnit)}) ÷ (1 − ${num(p.scrap_pct)}% brak) = ${u(varGood)}`,
    },
    revenue_costs: { value: round4(rcUnit), formula: `${u(price)} × ${num(rcPct)}% = ${u(rcUnit)}` },
    fixed: { value: round4(fixedUnit), formula: `${money(opexTotal)} ÷ ${num(unitsMonth)} ${unit} = ${u(fixedUnit)}` },
    cost: {
      value: round4(unitCost),
      formula: `${u(varGood)} + ${u(rcUnit)} + ${u(fixedUnit)} = ${u(unitCost)}`,
    },
    contribution: {
      value: round4(contribution),
      formula: `${u(price)} − ${u(varGood)} − ${u(rcUnit)} = ${u(contribution)}`,
    },
    profit: { value: round4(price - unitCost), formula: `${u(price)} − ${u(unitCost)} = ${u(price - unitCost)}` },
  };

  // Month at base utilization: revenue → gross profit → operating profit. Never capacity × price.
  const monthOf = (units: number) => {
    const revenue = units * price;
    const variable = units * varGood;
    const rc = (revenue * rcPct) / 100;
    const gross = revenue - variable - rc;
    return { revenue, variable, rc, gross, operating: gross - opexTotal };
  };
  const m = monthOf(unitsMonthExact);
  const month: ManufacturingModel["month"] = {
    units: unitsMonth,
    revenue: { value: round(m.revenue), formula: `${num(unitsMonth)} ${unit} × ${u(price)} = ${money(round(m.revenue))}` },
    variable_costs: {
      value: round(m.variable),
      formula: `${num(round(unitsMonthExact / good))} ${unit} ishlab chiqarilgan (brak bilan) × ${u(varProduced)} = ${money(round(m.variable))}`,
    },
    revenue_costs: {
      value: round(m.rc),
      formula: `${money(round(m.revenue))} × ${num(rcPct)}% = ${money(round(m.rc))}`,
    },
    gross_profit: {
      value: round(m.gross),
      formula: `${money(round(m.revenue))} − ${money(round(m.variable))} − ${money(round(m.rc))} = ${moneySigned(round(m.gross))}`,
    },
    fixed_costs: { value: opexTotal, formula: opexFormula },
    operating_profit: {
      value: round(m.operating),
      formula: `${moneySigned(round(m.gross))} − ${money(opexTotal)} = ${moneySigned(round(m.operating))}`,
    },
    margin_pct: m.revenue > 0 ? round1((m.operating / m.revenue) * 100) : null,
  };

  // Break-even
  let breakEven: ManufacturingModel["break_even"];
  if (contribution > 0) {
    const beUnits = Math.ceil(opexTotal / contribution - 1e-9);
    const beUtil = beUnits / (cap * good * p.hours_per_day * p.working_days_per_month);
    breakEven = {
      units: { value: beUnits, formula: `${money(opexTotal)} ÷ ${u(contribution)} = ${num(beUnits)} ${unit}/oy` },
      revenue: { value: round(beUnits * price), formula: `${num(beUnits)} ${unit} × ${u(price)} = ${money(round(beUnits * price))}` },
      utilization: {
        value: round1(beUtil * 100),
        formula: `${num(beUnits)} ÷ ${num(maxMonth)} ${unit} (100% yuklama) = ${num(round1(beUtil * 100))}%`,
      },
    };
    if (beUtil > 1) warnings.push("Zararsizlik nuqtasi uskunaning maksimal quvvatidan yuqori: bu shartlarda foyda bo'lmaydi.");
  } else {
    const reason = `1 ${unit} sotish narxi (${u(price)}) o'zgaruvchan xarajatlardan (${u(varGood + rcUnit)}) past yoki teng: har bir ${unit} zarar keltiradi, zararsizlik nuqtasi yo'q.`;
    breakEven = {
      units: { value: null, formula: reason },
      revenue: { value: null, formula: "—" },
      utilization: { value: null, formula: "—" },
      reason,
    };
    warnings.push(reason);
  }

  // Payback = CAPEX ÷ monthly operating profit
  const op = round(m.operating);
  const payback: ManufacturingModel["payback"] =
    op > 0
      ? { value: round1(capexTotal / m.operating), formula: `${money(capexTotal)} ÷ ${money(op)}/oy = ${num(round1(capexTotal / m.operating))} oy` }
      : {
          value: null,
          formula: `Oylik operatsion foyda ${moneySigned(op)}: investitsiya qoplanmaydi, qoplanish muddati hisoblanmaydi.`,
          reason: "Asosiy ssenariyda operatsion foyda yo'q (zarar), shuning uchun qoplanish muddati hisoblanmaydi.",
        };
  if (op <= 0) warnings.push(payback.reason!);

  const scenarios = (data.scenarios?.length ? data.scenarios : DEFAULT_SCENARIOS).map((util): ScenarioRow => {
    const units = cap * util * good * p.hours_per_day * p.working_days_per_month;
    const s = monthOf(units);
    return {
      utilization: util,
      units: round(units),
      revenue: round(s.revenue),
      variable_costs: round(s.variable),
      revenue_costs: round(s.rc),
      gross_profit: round(s.gross),
      fixed_costs: opexTotal,
      operating_profit: round(s.operating),
      payback_months: round(s.operating) > 0 ? round1(capexTotal / s.operating) : null,
    };
  });

  return {
    capex: { rows: capexRows, total: capexTotal, excluded: capexExcluded, formula: `${listSum(capexRows, money)} = ${money(capexTotal)}` },
    opex: { rows: opexRows, total: opexTotal, excluded: opexExcluded, formula: opexFormula, electricity },
    variable: { rows: varRows, excluded: varExcluded, per_produced_unit: round4(varProduced), per_good_unit: unitEcon.variable },
    revenue_costs: { rows: rcRows, pct: rcPct },
    capacity,
    unit: unitEcon,
    month,
    break_even: breakEven,
    payback,
    scenarios,
    weakest,
    warnings,
  };
}

/** Structural check of a manufacturing research package. Returns human-readable problems (Russian, for the admin). */
export function validateManufacturing(raw: unknown): { ok: true; data: ManufacturingResearch } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const d = raw as Partial<ManufacturingResearch> | null;
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  const str = (x: unknown) => typeof x === "string" && x.trim().length > 0;
  const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  const need = (cond: boolean, msg: string) => void (cond || errors.push(msg));
  const https = (x: unknown) => typeof x === "string" && /^https:\/\/[^\s]+$/.test(x);

  if (!isObj(d)) return { ok: false, errors: ["Файл не похож на research-пакет производства (ожидается JSON-объект)."] };
  need(typeof d.slug === "string" && /^[a-z0-9][a-z0-9-]{1,39}$/.test(d.slug), "slug: латиница, цифры и дефис, 2–40 символов");
  need(str(d.title), "title: нужен заголовок");
  need(typeof d.research_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.research_date), "research_date: формат ГГГГ-ММ-ДД");
  need(d.currency === "USD", "currency: пока поддерживается только USD");

  const sourceIds = new Set(Array.isArray(d.sources) ? d.sources.map((s) => s?.id) : []);
  const checkSource = (id: unknown, where: string) =>
    need(id === null || id === undefined || sourceIds.has(id as number), `${where}: источник [${String(id)}] не найден в sources`);
  const inputLabel = (label: unknown, where: string) =>
    need(DATA_LABELS.includes(label as DataLabel) && label !== "CALCULATED", `${where}.label: метка входных данных (${DATA_LABELS.filter((l) => l !== "CALCULATED").join(", ")})`);
  const checkLabeled = (x: unknown, where: string) => {
    if (!isObj(x)) return void errors.push(`${where}: нужен объект {value, label, source}`);
    need(str(x.value), `${where}.value: пусто`);
    inputLabel(x.label, where);
    checkSource(x.source, where);
  };
  /** value: number ≥ 0 or null; UNKNOWN ⇔ null. */
  const checkNumber = (x: unknown, where: string, opts: { required?: boolean; positive?: boolean } = {}) => {
    if (!isObj(x)) return void errors.push(`${where}: нужен объект {value, label, source}`);
    need(x.value === null || (finite(x.value) && x.value >= 0), `${where}.value: число ≥ 0 или null`);
    inputLabel(x.label, where);
    need(x.label !== "UNKNOWN" || x.value === null, `${where}: у UNKNOWN значение должно быть null`);
    need(x.value !== null || x.label === "UNKNOWN", `${where}: null допустим только с меткой UNKNOWN`);
    if (opts.required) need(finite(x.value) && x.value > 0 && x.label !== "UNKNOWN", `${where}: без этого значения модель не считается, нужно число > 0`);
    else if (opts.positive && finite(x.value)) need(x.value > 0, `${where}.value: должно быть > 0`);
    checkSource(x.source, where);
  };
  const checkMoneyList = (list: unknown, name: string, field: "amount" | "pct") => {
    if (!Array.isArray(list) || list.length === 0) return void errors.push(`${name}: нужен непустой список`);
    list.forEach((it, i) => {
      const where = `${name}[${i}]${isObj(it) && str(it.key) ? ` (${String(it.key)})` : ""}`;
      if (!isObj(it)) return void errors.push(`${where}: нужен объект`);
      need(str(it.key), `${where}.key: пусто`);
      need(str(it.title), `${where}.title: пусто`);
      inputLabel(it.label, where);
      const v = it[field];
      need(v === null || (finite(v) && v >= 0 && (field === "amount" || v <= 100)), `${where}.${field}: число ≥ 0 или null`);
      need(it.label !== "UNKNOWN" || v === null, `${where}: у UNKNOWN ${field} должен быть null`);
      need(v !== null || it.label === "UNKNOWN", `${where}: ${field} = null допустим только с меткой UNKNOWN`);
      checkSource(it.source, where);
    });
  };
  const strList = (x: unknown, where: string, min = 1) =>
    need(Array.isArray(x) && x.length >= min && x.every(str), `${where}: нужен список строк${min > 1 ? ` (минимум ${min})` : ""}`);

  const pr = d.product;
  if (!isObj(pr)) errors.push("product: нужен объект");
  else for (const key of ["name", "tagline", "description", "unit"] as const) need(str(pr[key]), `product.${key}: пусто`);

  const e = d.equipment;
  if (!isObj(e)) errors.push("equipment: нужен объект");
  else {
    need(str(e.name), "equipment.name: пусто");
    for (const key of ["manufacturer", "model", "weight", "automation", "installation", "lead_time", "warranty"] as const) {
      checkLabeled(e[key], `equipment.${key}`);
    }
    checkNumber(e.price, "equipment.price");
    checkNumber(e.capacity_per_hour, "equipment.capacity_per_hour", { required: true });
    checkNumber(e.power_kw, "equipment.power_kw", { positive: true });
    checkNumber(e.area_m2, "equipment.area_m2", { positive: true });
    checkNumber(e.operators, "equipment.operators", { positive: true });
    if (e.image_url !== undefined)
      need(
        https(e.image_url) && /\.(jpe?g|png|webp)/i.test(String(e.image_url)),
        "equipment.image_url: прямая ссылка https на картинку JPG/PNG (или удалите поле)",
      );
    need(Array.isArray(e.included), "equipment.included: нужен список");
    need(Array.isArray(e.additional_equipment), "equipment.additional_equipment: нужен список");
    if (!Array.isArray(e.raw_materials) || e.raw_materials.length === 0) errors.push("equipment.raw_materials: нужен хотя бы один вид сырья");
    else
      e.raw_materials.forEach((r, i) => {
        if (!isObj(r) || !str(r.name) || !str(r.spec)) return void errors.push(`equipment.raw_materials[${i}]: нужны name и spec`);
        checkLabeled(r.price, `equipment.raw_materials[${i}].price`);
      });
  }

  need(
    Array.isArray(d.highlights) && d.highlights.length >= 2 && d.highlights.length <= 4 && d.highlights.every(str),
    "highlights: от 2 до 4 строк",
  );
  if (d.post_stats !== undefined) {
    if (!Array.isArray(d.post_stats)) errors.push("post_stats: нужен список {label, value, source}");
    else
      d.post_stats.forEach((st, i) => {
        if (!isObj(st) || !str(st.label) || !str(st.value)) return void errors.push(`post_stats[${i}]: нужны label и value`);
        need(st.source !== null && st.source !== undefined, `post_stats[${i}]: цифры для поста нужны с источником`);
        checkSource(st.source, `post_stats[${i}]`);
      });
  }

  const mk = d.market;
  if (!isObj(mk)) errors.push("market: нужен объект");
  else {
    need(str(mk.summary), "market.summary: пусто");
    need(str(mk.distribution), "market.distribution: пусто");
    checkNumber(mk.selling_price_per_unit, "market.selling_price_per_unit", { required: true });
    if (mk.wholesale_price !== undefined) checkNumber(mk.wholesale_price, "market.wholesale_price");
    if (mk.imports_local !== undefined) checkLabeled(mk.imports_local, "market.imports_local");
    if (!Array.isArray(mk.demand_indicators)) errors.push("market.demand_indicators: нужен список");
    else mk.demand_indicators.forEach((x, i) => checkLabeled(x, `market.demand_indicators[${i}]`));
    if (!Array.isArray(mk.competitors)) errors.push("market.competitors: нужен список");
    else
      mk.competitors.forEach((c, i) => {
        need(isObj(c) && str(c.name), `market.competitors[${i}]: нужно name`);
        if (isObj(c)) checkSource(c.source, `market.competitors[${i}]`);
      });
    for (const key of ["customers", "risks", "limitations"] as const) need(Array.isArray(mk[key]), `market.${key}: нужен список`);
  }

  checkMoneyList(d.capex, "capex", "amount");
  checkMoneyList(d.opex_monthly, "opex_monthly", "amount");
  checkMoneyList(d.variable_costs, "variable_costs", "amount");
  if (d.revenue_costs !== undefined && !(Array.isArray(d.revenue_costs) && d.revenue_costs.length === 0)) checkMoneyList(d.revenue_costs, "revenue_costs", "pct");

  const p = d.production;
  if (!isObj(p)) errors.push("production: нужен объект");
  else {
    need(finite(p.hours_per_day) && p.hours_per_day > 0 && p.hours_per_day <= 24, "production.hours_per_day: число от 1 до 24");
    need(Number.isInteger(p.shifts_per_day) && (p.shifts_per_day as number) >= 1 && (p.shifts_per_day as number) <= 3, "production.shifts_per_day: целое от 1 до 3");
    need(finite(p.working_days_per_month) && p.working_days_per_month > 0 && p.working_days_per_month <= 31, "production.working_days_per_month: число от 1 до 31");
    need(finite(p.utilization_base) && p.utilization_base > 0 && p.utilization_base <= 1, "production.utilization_base: доля от 0 до 1 (например 0.7)");
    need(finite(p.scrap_pct) && p.scrap_pct >= 0 && p.scrap_pct < 50, "production.scrap_pct: процент брака от 0 до 50");
    inputLabel(p.label, "production");
    checkSource(p.source, "production");
    if (p.electricity_price_kwh !== undefined) checkNumber(p.electricity_price_kwh, "production.electricity_price_kwh");
  }
  if (d.scenarios !== undefined)
    need(
      Array.isArray(d.scenarios) && d.scenarios.every((x) => finite(x) && x > 0 && x <= 1),
      "scenarios: список долей загрузки от 0 до 1, например [0.5, 0.7, 0.9]",
    );

  if (!Array.isArray(d.process) || d.process.length === 0) errors.push("process: нужен список этапов");
  else need(d.process.every((s) => isObj(s) && str(s.step) && str(s.text)), "process: каждый этап {step, text}");
  if (!Array.isArray(d.facility)) errors.push("facility: нужен список требований");
  else
    d.facility.forEach((f, i) => {
      if (!isObj(f) || !str(f.title)) return void errors.push(`facility[${i}]: нужно title`);
      checkLabeled(f, `facility[${i}]`);
    });
  if (!Array.isArray(d.risks) || d.risks.length === 0) errors.push("risks: нужен список рисков");
  else need(d.risks.every((r) => isObj(r) && str(r.title) && str(r.text)), "risks: каждый риск {title, text}");
  strList(d.verify_before_investment, "verify_before_investment");

  if (!Array.isArray(d.sources)) errors.push("sources: нужен список");
  else
    d.sources.forEach((s, i) => {
      need(
        isObj(s) && typeof s.id === "number" && str(s.url) && /^https?:\/\//.test(String(s.url)),
        `sources[${i}]: нужны id и url (http/https)`,
      );
      need(isObj(s) && SOURCE_TYPES.includes(s.type as (typeof SOURCE_TYPES)[number]), `sources[${i}].type: ${SOURCE_TYPES.join(", ")}`);
    });

  return errors.length ? { ok: false, errors } : { ok: true, data: d as ManufacturingResearch };
}
