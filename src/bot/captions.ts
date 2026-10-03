// Channel post captions. Rule from Abdul (2026-10-03): posts never show a price; the button sends people to the bot for it.
import type { LeadMagnetRow } from "../db";
import type { ExhibitionResearch } from "../pdf/exhibition";
import { escapeHtml } from "../telegram/api";

/** Telegram limit for a photo caption (visible characters). */
export const MAX_CAPTION = 1024;

/** Fits the first build that is within the caption limit, otherwise the last (shortest) one. */
export function fitCaption<T>(attempts: T[], build: (a: T) => string): string {
  for (const a of attempts) {
    const text = build(a);
    if (visibleLength(text) <= MAX_CAPTION) return text;
  }
  return build(attempts.at(-1)!);
}

/** Length as Telegram counts it: tags removed, entities decoded. */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]+>/g, "").replace(/&(lt|gt|amp|quot);/g, "x").length;
}

/**
 * Lead-generation caption in the style that works in Uzbek business channels: bold hook, what/when/where,
 * organizer figures, why go, deadline, a question about the trip cost and a CTA. The price itself is only in the bot. Sections are dropped from the end of the
 * priority list until it fits the 1024-character caption limit.
 */
export function buildPostText(magnet: LeadMagnetRow, research: ExhibitionResearch | null): string {
  const hook = "<b>📣 Tadbirkorlar diqqatiga!</b>";
  if (!research) {
    return `${hook}\n\n📄 <b>${escapeHtml(magnet.title)}</b>\n\nYangi material tayyor.\n\n👇 <b>Pastdagi tugmani bosing va materialni botda oling!</b>`;
  }
  const e = research.exhibition;
  const phase = e.phases.find((p) => p.name === e.focus_phase) ?? e.phases[0]!;
  const name = `${e.name}${e.edition ? ` ${e.edition}` : ""}`;

  const build = (o: { tagline: boolean; stats: number; why: number; phase: boolean }) => {
    const parts = [hook];
    parts.push(`🇨🇳 <b>${escapeHtml(name)}</b>${o.tagline && e.tagline ? ` — ${escapeHtml(e.tagline)}` : ""}`);
    parts.push(`📅 ${escapeHtml(e.dates.value)}\n📍 ${escapeHtml(e.city)}, Xitoy`);
    if (e.stats && o.stats > 0) {
      const items = e.stats.items.slice(0, o.stats).map((i) => `🔹 ${escapeHtml(i.value)} ${escapeHtml(i.label)}`);
      parts.push(`🌍 <b>${escapeHtml(e.stats.year)}-yil ko'rsatkichlari:</b>\n${items.join("\n")}`);
    }
    if (o.why > 0) {
      parts.push(`✅ <b>Nega borish kerak:</b>\n${e.relevance.slice(0, o.why).map((r) => `• ${escapeHtml(r)}`).join("\n")}`);
    }
    if (o.phase) parts.push(`🏷 <b>${escapeHtml(phase.name)}:</b> ${escapeHtml(phase.categories)}`);
    if (e.deadline && e.deadline.label !== "UNKNOWN") parts.push(`📌 <b>Ro'yxatdan o'tish:</b> ${escapeHtml(e.deadline.value)}`);
    parts.push(
      `💰 <b>Bu safar 2 kishiga qancha turadi?</b>\n` +
        `Aviachipta, mehmonxona, transport va boshqa xarajatlar: tayyor hisob-kitob, safar dasturi va tayyorgarlik ro'yxati botda.`,
    );
    parts.push(`👇 <b>Pastdagi tugmani bosing va safar narxini bilib oling!</b>`);
    return parts.join("\n\n");
  };
  const attempts = [
    { tagline: true, stats: 5, why: 3, phase: true },
    { tagline: true, stats: 4, why: 3, phase: false },
    { tagline: true, stats: 3, why: 2, phase: false },
    { tagline: false, stats: 3, why: 2, phase: false },
    { tagline: false, stats: 0, why: 2, phase: false },
    { tagline: false, stats: 0, why: 0, phase: false },
  ];
  return fitCaption(attempts, build);
}

