// Exhibition trip guide: research data -> deterministic budget.
// The model (or a person) supplies inputs with labels and sources; every number in the PDF is computed here.

export const DATA_LABELS = ["VERIFIED", "MARKET DATA", "CALCULATED", "ESTIMATED", "ASSUMPTION", "UNKNOWN"] as const;
export type DataLabel = (typeof DATA_LABELS)[number];

export const SOURCE_TYPES = ["PRIMARY", "OFFICIAL", "MANUFACTURER", "GOV_INDUSTRY", "SECONDARY", "MARKETPLACE"] as const;

export interface Labeled {
  value: string;
  label: DataLabel;
  source: number | null;
}

export interface CostInput {
  key: string;
  title: string;
  /** null = price not found; such a row is shown but never added to the total. */
  unit_price: number | null;
  unit: string;
  /** Each factor is a scenario field name ("people", "nights", ...) or a literal number, with its unit word. */
  factors: [string | number, string][];
  label: DataLabel;
  source: number | null;
  note?: string;
}

export interface ExhibitionResearch {
  slug: string;
  title: string;
  sample?: boolean;
  research_date: string; // YYYY-MM-DD
  currency: "USD";
  exhibition: {
    name: string;
    full_name: string;
    official_site: string;
    organizer: string;
    venue: string;
    city: string;
    dates: Labeled;
    phases: { name: string; dates: string; categories: string }[];
    focus_phase?: string;
    relevance: string[];
    visitor_info: Labeled;
    registration: Labeled;
    /** Optional, for the channel post and cover image. */
    edition?: string; // e.g. "2027" or "141-sessiya"
    tagline?: string; // one line: what this exhibition is
    stats?: { year: string; source: number | null; items: { label: string; value: string }[] };
    deadline?: Labeled; // registration / application deadline
  };
  scenario: {
    people: number;
    route: string;
    trip_dates: string;
    nights: number;
    days: number;
    rooms: number;
    hotel_category: string;
    hotel_short?: string;
  };
  inputs: CostInput[];
  reserve_pct: number;
  program: { day: string; text: string }[];
  checklist: string[];
  practical: { title: string; text: string }[];
  sources: { id: number; title: string; url: string; type: string; retrieved_at: string }[];
}

export interface BudgetRow extends CostInput {
  units: number;
  amount: number | null;
  formula: string;
}

export interface Budget {
  rows: BudgetRow[];
  subtotal: number;
  reserve: number;
  total: number;
  perPerson: number;
  /** Weakest label among the inputs that made it into the total. */
  weakest: DataLabel;
  excluded: BudgetRow[];
}

// Indicative budget: whole dollars are precise enough and read cleaner.
const round = (x: number) => Math.round(x);

export function money(x: number): string {
  return "$" + x.toLocaleString("en-US", { maximumFractionDigits: 0 }).replace(/,/g, " ");
}

export function calculateBudget(data: ExhibitionResearch): Budget {
  const scenario = data.scenario as unknown as Record<string, number>;
  const rows = data.inputs.map((input): BudgetRow => {
    const factors = input.factors.map(([f, unit]) => ({ n: typeof f === "number" ? f : scenario[f]!, unit }));
    const units = factors.reduce((acc, f) => acc * f.n, 1);
    const known = input.unit_price !== null && input.label !== "UNKNOWN";
    return {
      ...input,
      units,
      amount: known ? round(input.unit_price! * units) : null,
      formula: known ? `${money(input.unit_price!)} × ${factors.map((f) => `${f.n} ${f.unit}`).join(" × ")}` : "—",
    };
  });
  const subtotal = rows.reduce((acc, r) => acc + (r.amount ?? 0), 0);
  const reserve = round((subtotal * data.reserve_pct) / 100);
  const total = subtotal + reserve;
  const weakest = rows
    .filter((r) => r.amount !== null)
    .reduce<DataLabel>((w, r) => (DATA_LABELS.indexOf(r.label) > DATA_LABELS.indexOf(w) ? r.label : w), "VERIFIED");
  return {
    rows,
    subtotal,
    reserve,
    total,
    perPerson: round(total / data.scenario.people),
    weakest,
    excluded: rows.filter((r) => r.amount === null),
  };
}

/** Structural check of a research package. Returns human-readable problems (Russian, for the admin). */
export function validateResearch(raw: unknown): { ok: true; data: ExhibitionResearch } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const d = raw as Partial<ExhibitionResearch> | null;
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  const str = (x: unknown) => typeof x === "string" && x.trim().length > 0;
  const pos = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x > 0;
  const need = (cond: boolean, msg: string) => void (cond || errors.push(msg));

  if (!isObj(d)) return { ok: false, errors: ["Файл не похож на research-пакет (ожидается JSON-объект)."] };
  need(typeof d.slug === "string" && /^[a-z0-9][a-z0-9-]{1,39}$/.test(d.slug), "slug: латиница, цифры и дефис, 2–40 символов");
  need(str(d.title), "title: нужен заголовок");
  need(typeof d.research_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.research_date), "research_date: формат ГГГГ-ММ-ДД");
  need(d.currency === "USD", "currency: пока поддерживается только USD");
  need(typeof d.reserve_pct === "number" && d.reserve_pct >= 0 && d.reserve_pct <= 30, "reserve_pct: число от 0 до 30");

  const sourceIds = new Set(Array.isArray(d.sources) ? d.sources.map((s) => s?.id) : []);
  const checkSource = (id: unknown, where: string) =>
    need(id === null || id === undefined || sourceIds.has(id as number), `${where}: источник [${String(id)}] не найден в sources`);
  const checkLabeled = (x: unknown, where: string) => {
    if (!isObj(x)) return void errors.push(`${where}: нужен объект {value, label, source}`);
    need(str(x.value), `${where}.value: пусто`);
    need(DATA_LABELS.includes(x.label as DataLabel), `${where}.label: одна из ${DATA_LABELS.join(", ")}`);
    checkSource(x.source, where);
  };

  const e = d.exhibition;
  if (!isObj(e)) errors.push("exhibition: нужен объект");
  else {
    for (const key of ["name", "full_name", "official_site", "organizer", "venue", "city"] as const) {
      need(str(e[key]), `exhibition.${key}: пусто`);
    }
    checkLabeled(e.dates, "exhibition.dates");
    checkLabeled(e.visitor_info, "exhibition.visitor_info");
    checkLabeled(e.registration, "exhibition.registration");
    need(Array.isArray(e.phases) && e.phases.length > 0, "exhibition.phases: нужен хотя бы один этап");
    need(Array.isArray(e.relevance) && e.relevance.length > 0, "exhibition.relevance: нужен хотя бы один пункт");
    if (e.deadline !== undefined) checkLabeled(e.deadline, "exhibition.deadline");
    if (e.stats !== undefined) {
      const st = e.stats as unknown;
      if (!isObj(st) || !str(st.year) || !Array.isArray(st.items)) errors.push("exhibition.stats: {year, source, items: [{label, value}]}");
      else {
        checkSource(st.source, "exhibition.stats");
        need(st.source !== null && st.source !== undefined, "exhibition.stats: цифры выставки нужны с источником");
        need(
          (st.items as unknown[]).every((it) => isObj(it) && str(it.label) && str(it.value)),
          "exhibition.stats.items: каждый пункт {label, value}",
        );
      }
    }
  }

  const s = d.scenario;
  if (!isObj(s)) errors.push("scenario: нужен объект");
  else {
    for (const key of ["people", "nights", "days", "rooms"] as const) need(pos(s[key]), `scenario.${key}: положительное число`);
    for (const key of ["route", "trip_dates", "hotel_category"] as const) need(str(s[key]), `scenario.${key}: пусто`);
  }

  if (!Array.isArray(d.inputs) || d.inputs.length === 0) errors.push("inputs: нужен список расходов");
  else {
    d.inputs.forEach((it, i) => {
      const where = `inputs[${i}]${isObj(it) && str(it.key) ? ` (${String(it.key)})` : ""}`;
      if (!isObj(it)) return void errors.push(`${where}: нужен объект`);
      need(str(it.title), `${where}.title: пусто`);
      need(DATA_LABELS.includes(it.label as DataLabel) && it.label !== "CALCULATED", `${where}.label: метка входных данных`);
      need(
        it.unit_price === null || (typeof it.unit_price === "number" && it.unit_price >= 0),
        `${where}.unit_price: число ≥ 0 или null`,
      );
      need(it.label !== "UNKNOWN" || it.unit_price === null, `${where}: у UNKNOWN цена должна быть null`);
      need(
        Array.isArray(it.factors) &&
          it.factors.every(
            (f) =>
              Array.isArray(f) &&
              str(f[1]) &&
              (pos(f[0]) || (typeof f[0] === "string" && isObj(s) && pos(s[f[0] as keyof typeof s]))),
          ),
        `${where}.factors: [[поле сценария или число, "единица"], ...]`,
      );
      checkSource(it.source, where);
    });
  }

  for (const key of ["program", "checklist", "practical", "sources"] as const) {
    need(Array.isArray(d[key]), `${key}: нужен список`);
  }
  if (Array.isArray(d.sources)) {
    d.sources.forEach((src, i) => {
      need(
        isObj(src) && typeof src.id === "number" && str(src.url) && /^https?:\/\//.test(String(src.url)),
        `sources[${i}]: нужны id и url (http/https)`,
      );
      need(isObj(src) && SOURCE_TYPES.includes(src.type as (typeof SOURCE_TYPES)[number]), `sources[${i}].type: ${SOURCE_TYPES.join(", ")}`);
    });
  }

  return errors.length ? { ok: false, errors } : { ok: true, data: d as ExhibitionResearch };
}
