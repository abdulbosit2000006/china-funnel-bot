// Content System V1: rubrics, formats, topic scoring and the checks a draft must pass.
// The model proposes and scores topics; the totals, thresholds and hard stops are decided here.
import { normalizeUrl, wasSeen } from "../ai/openai";

export const RUBRICS = ["BUSINESS_MODEL", "TRUST", "OPPORTUNITY", "INSIGHT", "BREAKING"] as const;
export type Rubric = (typeof RUBRICS)[number];

export const FORMATS: Record<Rubric, readonly string[]> = {
  BUSINESS_MODEL: ["MANUFACTURING"],
  TRUST: ["MASLAHAT", "XATO", "CHECKLIST", "REAL_CASE", "KNOWLEDGE"],
  OPPORTUNITY: ["EXHIBITION", "TECHNOLOGY", "MACHINE", "RAW_MATERIAL", "TREND", "SUPPLY"],
  INSIGHT: ["WEEK_INSIGHT", "POLL"],
  BREAKING: ["NEWS"],
};

export const GOALS = ["LEAD_GENERATION", "TRUST", "RETENTION", "ENGAGEMENT", "AUTHORITY"] as const;
export type Goal = (typeof GOALS)[number];

export const CTA_TYPES = ["BOT_PDF", "BOT_QUESTION", "SAVE", "SHARE", "COMMENT", "POLL", "NONE"] as const;
export type CtaType = (typeof CTA_TYPES)[number];

export const RUBRIC_NAMES: Record<Rubric, string> = {
  BUSINESS_MODEL: "1 STANOK — 1 BIZNES",
  TRUST: "Ishonch (maslahat / keys)",
  OPPORTUNITY: "Xitoydagi imkoniyat",
  INSIGHT: "Hafta insayti",
  BREAKING: "Muhim yangilik",
};
export const RUBRIC_RU: Record<Rubric, string> = {
  BUSINESS_MODEL: "бизнес-модель",
  TRUST: "доверие",
  OPPORTUNITY: "возможность",
  INSIGHT: "инсайт",
  BREAKING: "BREAKING",
};

/** Weekday (0 = Sunday) of each weekly rubric. */
export const WEEK: { weekday: number; rubric: Rubric }[] = [
  { weekday: 1, rubric: "BUSINESS_MODEL" },
  { weekday: 3, rubric: "TRUST" },
  { weekday: 5, rubric: "OPPORTUNITY" },
  { weekday: 0, rubric: "INSIGHT" },
];

// ---------- Scoring ----------

export const SCORE_WEIGHTS = {
  relevance: 20,
  value: 20,
  evidence: 15,
  specificity: 10,
  novelty: 10,
  actionability: 10,
  lead_potential: 10,
  freshness: 5,
} as const;
export type ScoreKey = keyof typeof SCORE_WEIGHTS;

export const PUBLISH_THRESHOLD = 70;
/** Deep posts (business model, exhibitions) need a stronger topic. */
export const DEEP_THRESHOLD = 80;

export function thresholdFor(rubric: Rubric, format: string): number {
  return rubric === "BUSINESS_MODEL" || format === "EXHIBITION" ? DEEP_THRESHOLD : PUBLISH_THRESHOLD;
}

export interface TopicCandidate {
  topic: string;
  format: string;
  goal: Goal;
  /** Uzbek: what the entrepreneur gets from it ("Bu tadbirkorga nima beradi?"). */
  benefit: string;
  hook: string;
  angle?: string;
  scores: Partial<Record<ScoreKey, number>>;
  source_urls: string[];
  /** For EXHIBITION: the name as in the founder's list. */
  exhibition?: string;
  // Filled by the code:
  total?: number;
  topic_key?: string;
  flags?: string[];
  custom?: boolean;
}

/** Sum of the per-criterion scores, each clamped to its weight. */
export function totalScore(scores: Partial<Record<ScoreKey, number>>): number {
  let total = 0;
  for (const [key, max] of Object.entries(SCORE_WEIGHTS) as [ScoreKey, number][]) {
    const v = Number(scores[key] ?? 0);
    total += Math.max(0, Math.min(max, Number.isFinite(v) ? v : 0));
  }
  return Math.round(total);
}

/** Same topic regardless of case, punctuation and word order details: lowercase latin/cyrillic words, sorted. */
export function topicKey(topic: string): string {
  const words = topic
    .toLowerCase()
    .replace(/[ʻʼ'`’]/g, "")
    .split(/[^a-zа-яё0-9]+/i)
    .filter((w) => w.length > 2);
  return [...new Set(words)].sort().join("-").slice(0, 120);
}

/** Two topics are the same when most of the shorter one's words are in the other. */
export function sameTopic(a: string, b: string): boolean {
  const wa = new Set(a.split("-").filter(Boolean));
  const wb = new Set(b.split("-").filter(Boolean));
  if (!wa.size || !wb.size) return false;
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  let common = 0;
  for (const w of small) if (big.has(w)) common++;
  return common / small.size >= 0.75;
}

/**
 * Scores and filters the model's topics for one slot. Hard stops never depend on the score: a topic whose
 * sources the search never returned loses its evidence points and is flagged; a repeat of a topic published in the
 * last 90 days is dropped; below the threshold it is dropped.
 */
export function rankCandidates(
  raw: TopicCandidate[],
  rubric: Rubric,
  seen: Set<string>,
  recentKeys: string[],
): { kept: TopicCandidate[]; dropped: { topic: string; reason: string }[] } {
  const kept: TopicCandidate[] = [];
  const dropped: { topic: string; reason: string }[] = [];
  for (const c of raw) {
    if (!c || typeof c.topic !== "string" || !c.topic.trim()) continue;
    const format = FORMATS[rubric].includes(c.format) ? c.format : FORMATS[rubric][0]!;
    const goal: Goal = (GOALS as readonly string[]).includes(c.goal) ? c.goal : rubric === "TRUST" ? "TRUST" : "LEAD_GENERATION";
    const scores = { ...(c.scores ?? {}) };
    const flags: string[] = [];
    const urls = (Array.isArray(c.source_urls) ? c.source_urls : []).filter((u) => typeof u === "string" && normalizeUrl(u));
    const verified = urls.filter((u) => wasSeen(u, seen));
    if (!verified.length && rubric !== "TRUST") {
      scores.evidence = 0;
      flags.push("источник не из поиска");
    }
    const key = topicKey(c.topic);
    if (recentKeys.some((k) => sameTopic(k, key))) {
      dropped.push({ topic: c.topic, reason: "уже было за 90 дней" });
      continue;
    }
    const total = totalScore(scores);
    if (total < thresholdFor(rubric, format)) {
      dropped.push({ topic: c.topic, reason: `балл ${total} ниже порога ${thresholdFor(rubric, format)}` });
      continue;
    }
    kept.push({ ...c, format, goal, scores, source_urls: urls, total, topic_key: key, flags });
  }
  kept.sort((a, b) => b.total! - a.total!);
  return { kept: kept.slice(0, 4), dropped };
}

// ---------- Draft checks ----------

/** Generic phrases that make a post sound like AI. The admin can extend the list (setting content.cliches). */
export const DEFAULT_CLICHES = [
  "zamonaviy dunyoda",
  "noyob imkoniyat",
  "bugungi kunda hech kimga sir emas",
  "hech kimga sir emaski",
  "inqilobiy",
  "o'tkazib yubormang",
  "eng yaxshi tanlov",
  "muvaffaqiyat kaliti",
  "в современном мире",
  "уникальная возможность",
  "не упустите",
  "ни для кого не секрет",
];

export function findCliches(text: string, list: string[]): string[] {
  const lower = text.toLowerCase().replace(/[ʻʼ`’]/g, "'");
  return list.filter((c) => lower.includes(c.toLowerCase()));
}

export interface Claim {
  text: string;
  label: string;
  source_url: string | null;
  source_date?: string | null;
  /** Prices: EXW / FOB / CFR / DDP / retail ... */
  basis?: string | null;
  currency?: string | null;
  unit?: string | null;
  is_price?: boolean;
}

export interface TextDraft {
  text: string;
  format: string;
  goal: Goal;
  cta_type: CtaType;
  topic: string;
  claims: Claim[];
  poll?: { question: string; options: string[] } | null;
  /** INSIGHT / BREAKING: the model may decline when nothing strong happened. */
  skip?: string | null;
}

/** Telegram limit for a text message. */
export const MAX_TEXT = 4096;
const LABELS = ["VERIFIED", "MARKET DATA", "ESTIMATED", "ASSUMPTION", "UNKNOWN"];

/** Errors the model must fix (sent back as a repair round) and warnings shown to the admin. */
export function checkDraft(
  raw: unknown,
  rubric: Rubric,
  seen: Set<string>,
  cliches: string[],
): { ok: true; draft: TextDraft; warnings: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const d = raw as Partial<TextDraft> | null;
  if (!d || typeof d !== "object") return { ok: false, errors: ["ответ не JSON-объект"] };
  if (typeof d.skip === "string" && d.skip.trim() && (rubric === "INSIGHT" || rubric === "BREAKING")) {
    return { ok: true, draft: { text: "", format: FORMATS[rubric][0]!, goal: "RETENTION", cta_type: "NONE", topic: "", claims: [], skip: d.skip.trim() }, warnings: [] };
  }
  const text = typeof d.text === "string" ? d.text.trim() : "";
  if (text.length < 200) errors.push("text: пост слишком короткий (меньше 200 символов)");
  if (text.length > 3500) errors.push(`text: ${text.length} символов, нужно не больше 3500`);
  if (/<(?!\/?(b|i|u|s|code|a)\b)[^>]*>/i.test(text)) errors.push("text: допустимы только теги <b>, <i>, <u>, <s>, <code>, <a>");
  const found = findCliches(text, cliches);
  if (found.length) errors.push(`text: убери шаблонные фразы: ${found.join("; ")}`);
  const format = typeof d.format === "string" && FORMATS[rubric].includes(d.format) ? d.format : FORMATS[rubric][0]!;
  const claims = Array.isArray(d.claims) ? (d.claims as Claim[]) : [];
  claims.forEach((c, i) => {
    if (!c || typeof c.text !== "string") return void errors.push(`claims[${i}]: нет text`);
    if (!LABELS.includes(c.label)) errors.push(`claims[${i}].label: одно из ${LABELS.join(", ")}`);
    if (["VERIFIED", "MARKET DATA"].includes(c.label) && !c.source_url) errors.push(`claims[${i}]: для ${c.label} нужен source_url`);
    if (c.is_price) {
      for (const f of ["basis", "currency", "unit", "source_date"] as const) {
        if (!c[f]) errors.push(`claims[${i}]: у цены обязательно поле ${f} (базис, валюта, единица, дата)`);
      }
    }
  });
  if (format === "RAW_MATERIAL" && !claims.some((c) => c.is_price)) errors.push("RAW_MATERIAL: нужна хотя бы одна цена-ориентир в claims с is_price: true");
  const poll = d.poll && typeof d.poll === "object" ? d.poll : null;
  if (poll && (typeof poll.question !== "string" || !Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 10)) {
    errors.push("poll: нужен question и 2–10 options");
  }
  if (errors.length) return { ok: false, errors };

  const warnings: string[] = [];
  const unseen = claims.filter((c) => c.source_url && !wasSeen(c.source_url, seen));
  if (unseen.length) warnings.push(`источники не из поиска: ${unseen.map((c) => c.source_url).join(", ")}`);
  const numbers = (text.replace(/<[^>]+>/g, "").match(/\d[\d\s.,]*\d|\d/g) ?? []).map((n) => n.replace(/\s/g, "")).filter((n) => n.length >= 2);
  const covered = claims.map((c) => c.text.replace(/\s/g, "")).join(" ");
  const loose = [...new Set(numbers.filter((n) => !covered.includes(n)))];
  if (loose.length) warnings.push(`числа без подтверждения в claims: ${loose.slice(0, 8).join(", ")}`);
  const cta = (["BOT_PDF", "BOT_QUESTION", "SAVE", "SHARE", "COMMENT", "POLL", "NONE"] as const).find((x) => x === d.cta_type) ?? "NONE";
  const goal = (GOALS as readonly string[]).includes(d.goal as string) ? (d.goal as Goal) : rubric === "TRUST" ? "TRUST" : "AUTHORITY";
  return {
    ok: true,
    draft: { text, format, goal, cta_type: cta === "BOT_PDF" ? "BOT_QUESTION" : cta, topic: String(d.topic ?? "").slice(0, 200), claims, poll: poll as TextDraft["poll"] },
    warnings,
  };
}

// ---------- Private data in case notes ----------

/** What the code still finds after the model's anonymisation: phones, e-mails, @handles, links, money amounts. */
export function findPrivateData(text: string): string[] {
  const found: string[] = [];
  const add = (kind: string, re: RegExp) => {
    const m = text.match(re);
    if (m) found.push(`${kind}: ${[...new Set(m)].slice(0, 3).join(", ")}`);
  };
  add("телефон", /\+?\d[\d\s()-]{8,}\d/g);
  add("e-mail", /[\w.+-]+@[\w-]+\.[\w.]+/g);
  add("@ник", /(^|\s)@[A-Za-z0-9_]{4,}/g);
  add("ссылка", /https?:\/\/\S+/g);
  add("сумма", /(\$\s?\d[\d\s.,]*|\d[\d\s.,]*\s?(usd|\$|so'm|сум|yuan|юан|¥|rmb))/gi);
  return found;
}
