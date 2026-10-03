// Channel post captions. Rule from Abdul (2026-10-03): posts never show a price; the button sends people to the bot for it.
import type { LeadMagnetRow } from "../db";
import type { ExhibitionResearch } from "../pdf/exhibition";
import type { ManufacturingResearch } from "../pdf/manufacturing";
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


/**
 * Business idea post: hook, what is produced, the concrete line, verified figures, why it is interesting, and the
 * question about investment and payback. The numbers themselves are in the PDF in the bot.
 */
export function manufacturingCaption(data: ManufacturingResearch): string {
  const hook = "<b>📣 Tadbirkorlar diqqatiga!</b>";
  const build = (o: { tagline: boolean; stats: number; why: number }) => {
    const parts = [hook];
    parts.push(`🏭 <b>${escapeHtml(data.product.name)}</b>${o.tagline && data.product.tagline ? ` — ${escapeHtml(data.product.tagline)}` : ""}`);
    parts.push(`⚙️ <b>Liniya:</b> ${escapeHtml(data.equipment.name)}`);
    if (data.post_stats?.length && o.stats > 0) {
      parts.push(`📊 <b>Asosiy ko'rsatkichlar:</b>\n${data.post_stats.slice(0, o.stats).map((s) => `🔹 ${escapeHtml(s.label)}: ${escapeHtml(s.value)}`).join("\n")}`);
    }
    if (o.why > 0 && data.highlights.length) {
      parts.push(`✅ <b>Nega qiziq:</b>\n${data.highlights.slice(0, o.why).map((h) => `• ${escapeHtml(h)}`).join("\n")}`);
    }
    parts.push(
      `💰 <b>Qancha investitsiya kerak va qachon o'zini oqlaydi?</b>\n` +
        `Uskuna, xomashyo, xarajatlar, tannarx, foyda va o'zini oqlash muddati: to'liq hisob-kitob botda.`,
    );
    parts.push(`👇 <b>Pastdagi tugmani bosing va biznes hisob-kitobini oling!</b>`);
    return parts.join("\n\n");
  };
  return fitCaption(
    [
      { tagline: true, stats: 4, why: 3 },
      { tagline: true, stats: 3, why: 2 },
      { tagline: false, stats: 2, why: 2 },
      { tagline: false, stats: 0, why: 1 },
      { tagline: false, stats: 0, why: 0 },
    ],
    build,
  );
}
