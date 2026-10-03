import { dashboardStats, logAdminAction } from "../db";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { renderMagnetList } from "./magnets";
import { renderWeek } from "./plan";
import { renderLeads, renderStatistics } from "./stats";
import { adminTexts } from "./texts";

export const ADMIN_CALLBACK_PREFIX = "adm:";

// Sections from the brief (§37). Only the dashboard is live in Phase 1.
const SECTIONS: { key: string; title: string }[] = [
  { key: "dashboard", title: "📊 Dashboard" },
  { key: "research", title: "🔎 Research" },
  { key: "magnets", title: "📄 Lead Magnets" },
  { key: "content", title: "🗓 Эта неделя" },
  { key: "publish", title: "📢 Publish" },
  { key: "leads", title: "🔥 Leads" },
  { key: "stats", title: "📈 Statistics" },
  { key: "settings", title: "⚙️ Settings" },
];

export function adminMenuKeyboard(): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < SECTIONS.length; i += 2) {
    rows.push(
      SECTIONS.slice(i, i + 2).map((s) => ({ text: s.title, callback_data: ADMIN_CALLBACK_PREFIX + s.key })),
    );
  }
  return rows;
}

const backKeyboard: InlineKeyboard = [[{ text: adminTexts.back, callback_data: ADMIN_CALLBACK_PREFIX + "menu" }]];

export async function sendAdminMenu(tg: Telegram, chatId: number): Promise<void> {
  await sendMessage(tg, chatId, adminTexts.menuTitle, adminMenuKeyboard());
}

async function renderSection(db: D1Database, key: string, now: Date, timeZone: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  if (key === "menu") return { text: adminTexts.menuTitle, keyboard: adminMenuKeyboard() };
  const section = SECTIONS.find((s) => s.key === key);
  if (!section) return { text: adminTexts.menuTitle, keyboard: adminMenuKeyboard() };
  if (key === "magnets") return renderMagnetList(db);
  if (key === "content") {
    const week = await renderWeek(db, now, timeZone);
    return { text: week.text, keyboard: [...week.keyboard, ...backKeyboard] };
  }
  if (key === "leads") return { text: await renderLeads(db), keyboard: backKeyboard };
  if (key === "stats") return { text: await renderStatistics(db, now), keyboard: backKeyboard };
  if (key === "research") {
    const text =
      `<b>🔎 Research</b>\n\n` +
      `AI сам ищет выставки и собирает research с источниками; бюджет считает код, PDF и пост приходят вам на одобрение.\n\n` +
      `• <b>🔎 Найти выставки</b> или <code>/find металл</code>: список подходящих выставок, по любой можно запустить research.\n` +
      `• <code>/research CIIF Shanghai 2027</code>: research сразу по названию.\n` +
      `• <b>💡 Найти бизнес-идеи</b> или <code>/ideas упаковка</code>, <code>/business производство бумажных стаканов</code>: производственная бизнес-модель с расчётом.\n` +
      `• По субботам в 12:00 план недели: пн бизнес-модель с PDF, ср доверие (кейсы, советы), пт возможность, вс инсайт. <code>/week</code>, <code>/plan</code>.\n` +
      `• <code>/case</code>: кейс из ваших заметок и голосовых, <code>/breaking</code>: срочный пост по новости.\n` +
      `• <code>/expo</code>: ваши выставки (бот берёт выставки только оттуда), <code>/season on|off</code>.\n` +
      `• <code>/budget</code>: расход OpenAI за месяц и лимит, <code>/views</code>: просмотры постов.\n` +
      `• Можно прислать готовый research-пакет файлом .json.`;
    return {
      text,
      keyboard: [[{ text: "🔎 Найти выставки", callback_data: "ai:d" }], [{ text: "💡 Найти бизнес-идеи", callback_data: "ai:b" }], ...backKeyboard],
    };
  }
  if (key === "dashboard") {
    const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const stats = await dashboardStats(db, since);
    const stages = Object.entries(stats.stages)
      .map(([stage, n]) => `• ${escapeHtml(stage)}: ${n}`)
      .join("\n");
    const text =
      `<b>📊 Dashboard</b>\n\n` +
      `Пользователей всего: <b>${stats.usersTotal}</b>\n` +
      `Новых за 24 ч: <b>${stats.usersNew24h}</b>\n` +
      `Входов в бота (/start) за 24 ч: <b>${stats.starts24h}</b>\n` +
      `Выдано PDF за 24 ч: <b>${stats.pdfs24h}</b>\n` +
      `«Хочу обсудить» за 24 ч: <b>${stats.cta24h}</b>\n\n` +
      `<b>Стадии лидов</b>\n${stages || "пока пусто"}`;
    return { text, keyboard: backKeyboard };
  }
  return { text: adminTexts.comingSoon(section.title), keyboard: backKeyboard };
}

export async function handleAdminCallback(
  tg: Telegram,
  db: D1Database,
  callback: { id: string; fromId: number; chatId: number; messageId: number; data: string },
  now: Date,
  timeZone = "Asia/Tashkent",
): Promise<void> {
  const key = callback.data.slice(ADMIN_CALLBACK_PREFIX.length);
  const { text, keyboard } = await renderSection(db, key, now, timeZone);
  await tg.call("answerCallbackQuery", { callback_query_id: callback.id });
  await tg.call("editMessageText", {
    chat_id: callback.chatId,
    message_id: callback.messageId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard },
  });
  await logAdminAction(db, callback.fromId, "open_section", now.toISOString(), { section: key });
}
