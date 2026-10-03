import { dashboardStats, logAdminAction } from "../db";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { adminTexts } from "./texts";

export const ADMIN_CALLBACK_PREFIX = "adm:";

// Sections from the brief (§37). Only the dashboard is live in Phase 1.
const SECTIONS: { key: string; title: string }[] = [
  { key: "dashboard", title: "📊 Dashboard" },
  { key: "research", title: "🔎 Research" },
  { key: "magnets", title: "📄 Lead Magnets" },
  { key: "content", title: "📝 Content" },
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

async function renderSection(db: D1Database, key: string, now: Date): Promise<{ text: string; keyboard: InlineKeyboard }> {
  if (key === "menu") return { text: adminTexts.menuTitle, keyboard: adminMenuKeyboard() };
  const section = SECTIONS.find((s) => s.key === key);
  if (!section) return { text: adminTexts.menuTitle, keyboard: adminMenuKeyboard() };
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
      `Входов в бота (/start) за 24 ч: <b>${stats.starts24h}</b>\n\n` +
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
): Promise<void> {
  const key = callback.data.slice(ADMIN_CALLBACK_PREFIX.length);
  const { text, keyboard } = await renderSection(db, key, now);
  await tg.call("answerCallbackQuery", { callback_query_id: callback.id });
  await tg.call("editMessageText", {
    chat_id: callback.chatId,
    message_id: callback.messageId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
  await logAdminAction(db, callback.fromId, "open_section", now.toISOString(), { section: key });
}
