// What differs between lead magnet subjects (exhibition trip guide, manufacturing business model).
// Everything else (research flow, PDF review, posts, autopilot) is shared and looks the subject up here.
import type { LeadMagnetRow, LeadMagnetType } from "../db";
import { discoverPrompt, researchPrompt, type Candidate } from "../ai/prompts";
import { DEFAULT_CONTENT } from "../pdf/content";
import { calculateBudget, money, validateResearch, type ExhibitionResearch } from "../pdf/exhibition";
import { exhibitionCard, type CardData } from "../pdf/post-card";
import { footerTemplate, renderExhibitionHtml, type Brand } from "../pdf/template";
import { escapeHtml } from "../telegram/api";
import { buildPostText, manufacturingCaption } from "./captions";
import { manufacturingDiscoverPrompt, manufacturingPrompt } from "../ai/prompts-manufacturing";
import { calculateManufacturing, moneySigned, validateManufacturing, type ManufacturingResearch } from "../pdf/manufacturing";
import { manufacturingFooter, renderManufacturingHtml } from "../pdf/manufacturing-template";

export type Subject = "EXHIBITION" | "MANUFACTURING";

export interface SubjectSpec {
  subject: Subject;
  /** research_items.kind */
  researchKind: "EXHIBITION" | "MANUFACTURING";
  magnetType: LeadMagnetType;
  funnelKind: "EXHIBITION" | "MANUFACTURING";
  /** Russian, for admin messages. */
  nameRu: string;
  discoverPrompt(today: string, topic: string | null, exclude: string[]): string;
  researchPrompt(today: string, target: Candidate | string): string;
  validate(raw: unknown): { ok: true; data: Researched } | { ok: false; errors: string[] };
  /** Admin summary of a valid package (HTML). */
  summary(data: Researched): string;
  calc(data: Researched): unknown;
  /** imageSrc: a data: URI of the equipment photo fetched beforehand (null hides it). */
  renderPdf(data: Researched, brand: Brand, imageSrc?: string | null): { html: string; footer: string };
  /** Photo for the PDF (fetched by the render job), if any. */
  pdfImageUrl(data: Researched): string | undefined;
  caption(magnet: LeadMagnetRow, data: Researched | null, opts?: { seriesNo?: number | null }): string;
  ctaButton: string;
  card(title: string, data: Researched | null): CardData;
  posterUrl(data: Researched): string | undefined;
}

/** A validated research package of any subject (each spec knows its own shape). */
export type Researched = { slug: string; title: string; research_date: string; sample?: boolean; sources: { id: number; url: string }[] };

const exhibition: SubjectSpec = {
  subject: "EXHIBITION",
  researchKind: "EXHIBITION",
  magnetType: "EXHIBITION_GUIDE",
  funnelKind: "EXHIBITION",
  nameRu: "выставка",
  discoverPrompt,
  researchPrompt,
  validate: (raw) => validateResearch(raw),
  summary(raw) {
    const data = raw as unknown as ExhibitionResearch;
    const budget = calculateBudget(data);
    const missing = budget.excluded.length
      ? `\n⚠️ Не вошло в итог (нет цены): ${budget.excluded.map((r) => escapeHtml(r.title)).join(", ")}`
      : "";
    return (
      `<b>${escapeHtml(data.title)}</b>\n` +
      `slug: <code>${data.slug}</code> · research ${data.research_date}\n` +
      `Итог на ${data.scenario.people} чел.: <b>${money(budget.total)}</b> (${money(budget.perPerson)} на человека)\n` +
      `Самая слабая метка во входных данных: ${budget.weakest}` +
      missing +
      (data.sample ? "\n🧪 Пакет помечен как образец: в PDF будет водяной знак NAMUNA." : "")
    );
  },
  calc: (raw) => calculateBudget(raw as unknown as ExhibitionResearch),
  renderPdf(raw, brand) {
    const data = raw as unknown as ExhibitionResearch;
    return { html: renderExhibitionHtml(data, calculateBudget(data), brand, DEFAULT_CONTENT), footer: footerTemplate(brand, data) };
  },
  caption: (magnet, raw) => buildPostText(magnet, raw as unknown as ExhibitionResearch | null),
  ctaButton: "✈️ Safar hisobini olish",
  card: (title, raw) => exhibitionCard(title, raw as unknown as ExhibitionResearch | null),
  posterUrl: (raw) => (raw as unknown as ExhibitionResearch).exhibition.poster_url,
  pdfImageUrl: () => undefined,
};

const manufacturing: SubjectSpec = {
  subject: "MANUFACTURING",
  researchKind: "MANUFACTURING",
  magnetType: "MANUFACTURING_MODEL",
  funnelKind: "MANUFACTURING",
  nameRu: "бизнес-модель",
  discoverPrompt: manufacturingDiscoverPrompt,
  researchPrompt: manufacturingPrompt,
  validate: (raw) => validateManufacturing(raw),
  summary(raw) {
    const data = raw as unknown as ManufacturingResearch;
    const m = calculateManufacturing(data);
    const payback = m.payback.value !== null ? `${m.payback.value} мес.` : `не считается (${escapeHtml(m.payback.reason ?? "нет прибыли")})`;
    return (
      `<b>${escapeHtml(data.title)}</b>\n` +
      `slug: <code>${data.slug}</code> · research ${data.research_date}\n` +
      `Линия: ${escapeHtml(data.equipment.name)}\n` +
      `CAPEX: <b>${money(m.capex.total)}</b> · операционная прибыль/мес: <b>${moneySigned(m.month.operating_profit.value ?? 0)}</b> · окупаемость: ${payback}\n` +
      `Самая слабая метка во входных данных: ${m.weakest}` +
      (m.warnings.length ? `\n⚠️ ${m.warnings.map((w) => escapeHtml(w)).join("\n⚠️ ")}` : "") +
      (data.sample ? "\n🧪 Пакет помечен как образец: в PDF будет водяной знак NAMUNA." : "")
    );
  },
  calc: (raw) => calculateManufacturing(raw as unknown as ManufacturingResearch),
  renderPdf(raw, brand, imageSrc) {
    const data = raw as unknown as ManufacturingResearch;
    return {
      html: renderManufacturingHtml(data, calculateManufacturing(data), brand, DEFAULT_CONTENT, { imageSrc: imageSrc ?? null }),
      footer: manufacturingFooter(brand, data),
    };
  },
  caption: (magnet, raw, opts) => (raw ? manufacturingCaption(raw as unknown as ManufacturingResearch, opts?.seriesNo) : buildPostText(magnet, null)),
  // CTA texts from Content Strategy V1 (Abdul, 2026-10-03).
  ctaButton: "📊 To'liq biznes hisob-kitobini olish",
  card(title, raw) {
    const data = raw as unknown as ManufacturingResearch | null;
    if (!data) return exhibitionCard(title, null);
    return {
      tag: "Biznes g'oya",
      kicker: "Ishlab chiqarish · O'zbekiston",
      heading: data.product.name,
      meta: [data.equipment.name.slice(0, 40)],
      tagline: data.product.tagline,
      chips: data.equipment.raw_materials.map((r) => r.name),
      box: { k: "Liniya + xomashyo + xarajatlar", v: "Foyda qancha?", s: "investitsiya · tannarx · o'zini oqlash", cta: "Botda bilib oling" },
      sample: data.sample,
    };
  },
  posterUrl: (raw) => (raw as unknown as ManufacturingResearch).equipment.image_url,
  pdfImageUrl: (raw) => (raw as unknown as ManufacturingResearch).equipment.image_url,
};

const SPECS: Partial<Record<Subject, SubjectSpec>> = { EXHIBITION: exhibition, MANUFACTURING: manufacturing };

export function subjectSpec(subject: Subject): SubjectSpec {
  const spec = SPECS[subject];
  if (!spec) throw new Error(`unknown subject ${subject}`);
  return spec;
}

export const hasSubject = (subject: Subject) => Boolean(SPECS[subject]);

export function specByResearchKind(kind: string): SubjectSpec {
  return subjectSpec(kind === "MANUFACTURING" ? "MANUFACTURING" : "EXHIBITION");
}

export function specByMagnetType(type: string): SubjectSpec | null {
  return Object.values(SPECS).find((s) => s.magnetType === type) ?? null;
}
