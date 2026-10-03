// What differs between lead magnet subjects (exhibition trip guide, manufacturing business model).
// Everything else (research flow, PDF review, posts, autopilot) is shared and looks the subject up here.
import type { LeadMagnetRow, LeadMagnetType } from "../db";
import { discoverPrompt, researchPrompt, type Candidate } from "../ai/prompts";
import { DEFAULT_CONTENT } from "../pdf/content";
import { calculateBudget, money, validateResearch, type ExhibitionResearch } from "../pdf/exhibition";
import { exhibitionCard, type CardData } from "../pdf/post-card";
import { footerTemplate, renderExhibitionHtml, type Brand } from "../pdf/template";
import { escapeHtml } from "../telegram/api";
import { buildPostText } from "./captions";

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
  renderPdf(data: Researched, brand: Brand): { html: string; footer: string };
  caption(magnet: LeadMagnetRow, data: Researched | null): string;
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
  ctaButton: "💰 Safar narxini bilish",
  card: (title, raw) => exhibitionCard(title, raw as unknown as ExhibitionResearch | null),
  posterUrl: (raw) => (raw as unknown as ExhibitionResearch).exhibition.poster_url,
};

const SPECS: Partial<Record<Subject, SubjectSpec>> = { EXHIBITION: exhibition };

export function registerSubject(spec: SubjectSpec): void {
  SPECS[spec.subject] = spec;
}

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
