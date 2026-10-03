import { createFunnelForSlug, getLeadMagnet, getSetting, logAdminAction, putSetting, type FunnelRow, type LeadMagnetRow } from "../db";
import { calculateBudget, money, type ExhibitionResearch } from "../pdf/exhibition";
import { fmtDate } from "../pdf/template";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import type { InlineKeyboard, TgChatMemberUpdated } from "../telegram/types";
import { botUsername } from "./magnets";

export const POST_CALLBACK_PREFIX = "pp:";
export const CHANNEL_SETTING = "channel";
const EDIT_SETTING = (adminId: number) => `await.post_edit.${adminId}`;
const CTA_BUTTON = "✈️ Tayyor hisob-kitobni olish";
const MAX_POST_LENGTH = 1024;

export interface ChannelInfo {
  id: number;
  title: string;
}

interface ContentRow {
  id: number;
  lead_magnet_id: number;
  funnel_id: number;
  text: string;
  status: string;
  channel_message_id: number | null;
}

/** Short lead-generation post (§16 of the brief): what, when, why it matters, budget teaser, CTA. Uzbek. */
export function buildPostText(magnet: LeadMagnetRow, research: ExhibitionResearch | null): string {
  if (!research) {
    return `📄 <b>${escapeHtml(magnet.title)}</b>\n\nYangi material tayyor. Pastdagi tugmani bosing va PDF'ni botda oling 👇`;
  }
  const e = research.exhibition;
  const budget = calculateBudget(research);
  const phase = e.phases.find((p) => p.name === e.focus_phase) ?? e.phases[0]!;
  const why = e.relevance.slice(0, 3).map((r) => `• ${escapeHtml(r)}`).join("\n");
  const excluded = budget.excluded.length
    ? ` (${budget.excluded.map((r) => escapeHtml(r.title.toLowerCase())).join(", ")} kirmagan)`
    : "";
  return (
    `🏭 <b>${escapeHtml(e.name)}</b> · ${escapeHtml(e.city)}, Xitoy\n` +
    `📅 ${escapeHtml(e.dates.value)}\n\n` +
    `<b>Nega borish kerak:</b>\n${why}\n\n` +
    `🏷 ${escapeHtml(phase.name)}: ${escapeHtml(phase.categories)}\n\n` +
    `💰 2 kishi uchun safar byudjeti: taxminan <b>${money(budget.total)}</b>${excluded}. ` +
    `Narxlar ${fmtDate(research.research_date)} holatiga ko'ra.\n\n` +
    `📄 Batafsil hisob-kitob, safar dasturi va tayyorgarlik ro'yxati PDF'da. Pastdagi tugmani bosing 👇`
  );
}

async function loadResearch(db: D1Database, magnet: LeadMagnetRow): Promise<ExhibitionResearch | null> {
  const row = await db
    .prepare("SELECT data FROM research_items WHERE id = (SELECT research_item_id FROM lead_magnets WHERE id = ?)")
    .bind(magnet.id)
    .first<{ data: string }>();
  return row ? (JSON.parse(row.data) as ExhibitionResearch) : null;
}

const getContent = (db: D1Database, id: number) =>
  db.prepare("SELECT * FROM content_items WHERE id = ?").bind(id).first<ContentRow>();

async function deepLink(tg: Telegram, db: D1Database, funnelId: number): Promise<string> {
  const funnel = await db.prepare("SELECT code FROM funnels WHERE id = ?").bind(funnelId).first<{ code: string }>();
  return `https://t.me/${await botUsername(tg, db)}?start=${funnel!.code}`;
}

/** Drafts a post for an active lead magnet and sends the admin an exact preview with controls. */
export async function createPostDraft(
  tg: Telegram,
  db: D1Database,
  chatId: number,
  magnet: LeadMagnetRow,
  funnel: FunnelRow,
  now: string,
): Promise<void> {
  const text = buildPostText(magnet, await loadResearch(db, magnet));
  const row = await db
    .prepare(
      "INSERT INTO content_items (lead_magnet_id, funnel_id, text, status, created_at) VALUES (?, ?, ?, 'PREVIEW', ?) RETURNING id",
    )
    .bind(magnet.id, funnel.id, text, now)
    .first<{ id: number }>();
  await db.prepare("UPDATE funnels SET content_item_id = ? WHERE id = ?").bind(row!.id, funnel.id).run();
  await sendPreview(tg, db, chatId, (await getContent(db, row!.id))!);
}

async function sendPreview(tg: Telegram, db: D1Database, chatId: number, item: ContentRow): Promise<void> {
  const channel = await getSetting<ChannelInfo>(db, CHANNEL_SETTING);
  const where = channel
    ? `Канал: <b>${escapeHtml(channel.title)}</b>`
    : "⚠️ Канал не подключён: добавьте бота администратором канала с правом публикации.";
  await sendMessage(tg, chatId, `📣 <b>Превью поста</b> (так он будет выглядеть в канале)\n${where}`);
  const keyboard: InlineKeyboard = [
    [{ text: CTA_BUTTON, url: await deepLink(tg, db, item.funnel_id) }],
    [
      { text: "✅ Опубликовать", callback_data: `${POST_CALLBACK_PREFIX}p:${item.id}` },
      { text: "✏️ Изменить текст", callback_data: `${POST_CALLBACK_PREFIX}e:${item.id}` },
    ],
    [{ text: "❌ Не публиковать", callback_data: `${POST_CALLBACK_PREFIX}x:${item.id}` }],
  ];
  await sendMessage(tg, chatId, item.text, keyboard);
}

export async function handlePostCallback(
  tg: Telegram,
  db: D1Database,
  callback: { id: string; fromId: number; chatId: number; messageId: number; data: string },
  now: Date,
): Promise<void> {
  const [action, rawId] = callback.data.slice(POST_CALLBACK_PREFIX.length).split(":");
  const at = now.toISOString();
  const answer = (text?: string) => tg.call("answerCallbackQuery", { callback_query_id: callback.id, ...(text ? { text } : {}) });

  // New post for an active lead magnet (button on the lead magnet card): every post gets its own campaign link.
  if (action === "n") {
    const magnet = await getLeadMagnet(db, Number(rawId));
    if (!magnet || magnet.status !== "ACTIVE") return void (await answer("Нужна активная версия."));
    await answer();
    const funnel = await createFunnelForSlug(db, magnet.slug, magnet.type === "EXHIBITION_GUIDE" ? "EXHIBITION" : "GENERAL", at);
    await createPostDraft(tg, db, callback.chatId, magnet, funnel, at);
    return;
  }

  const item = await getContent(db, Number(rawId));
  if (!item || item.status !== "PREVIEW") return void (await answer("Уже обработано."));

  if (action === "e") {
    await putSetting(db, EDIT_SETTING(callback.fromId), item.id);
    await answer();
    await sendMessage(tg, callback.chatId, "✏️ Пришлите новый текст поста одним сообщением. Кнопка под постом останется той же.");
    return;
  }
  const clearControls = () =>
    tg.call("editMessageReplyMarkup", {
      chat_id: callback.chatId,
      message_id: callback.messageId,
      reply_markup: { inline_keyboard: [] },
    });

  if (action === "x") {
    await db.prepare("UPDATE content_items SET status = 'REJECTED' WHERE id = ?").bind(item.id).run();
    await logAdminAction(db, callback.fromId, "post.reject", at, { id: item.id });
    await answer("Не опубликовано.");
    await clearControls();
    return;
  }
  if (action !== "p") return void (await answer());

  const channel = await getSetting<ChannelInfo>(db, CHANNEL_SETTING);
  if (!channel) {
    return void (await answer("Канал не подключён. Добавьте бота администратором канала и нажмите ещё раз."));
  }
  // Claim first so a double tap cannot publish twice.
  const claimed = await db
    .prepare("UPDATE content_items SET status = 'APPROVED' WHERE id = ? AND status = 'PREVIEW'")
    .bind(item.id)
    .run();
  if (!claimed.meta.changes) return void (await answer("Уже обработано."));
  try {
    const sent = await tg.call<{ message_id: number }>("sendMessage", {
      chat_id: channel.id,
      text: item.text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: CTA_BUTTON, url: await deepLink(tg, db, item.funnel_id) }]] },
    });
    await db
      .prepare("UPDATE content_items SET status = 'PUBLISHED', channel_message_id = ?, published_at = ? WHERE id = ?")
      .bind(sent.message_id, at, item.id)
      .run();
  } catch (error) {
    await db.prepare("UPDATE content_items SET status = 'PREVIEW' WHERE id = ?").bind(item.id).run();
    await answer("Telegram не дал опубликовать: проверьте, что бот админ канала с правом публикации.");
    throw error;
  }
  await logAdminAction(db, callback.fromId, "post.publish", at, { id: item.id, channel: channel.id });
  await answer("Опубликовано.");
  await clearControls();
  await sendMessage(tg, callback.chatId, `✅ Пост опубликован в канале «${escapeHtml(channel.title)}».`);
}

/** If the admin was asked for a new post text, take this message as that text. Returns true when consumed. */
export async function handlePostEditText(tg: Telegram, db: D1Database, adminId: number, chatId: number, text: string): Promise<boolean> {
  const itemId = await getSetting<number>(db, EDIT_SETTING(adminId));
  if (!itemId) return false;
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(EDIT_SETTING(adminId)).run();
  const item = await getContent(db, itemId);
  if (!item || item.status !== "PREVIEW") return false;
  const newText = escapeHtml(text.trim()).slice(0, MAX_POST_LENGTH);
  await db.prepare("UPDATE content_items SET text = ? WHERE id = ?").bind(newText, item.id).run();
  await sendPreview(tg, db, chatId, { ...item, text: newText });
  return true;
}

/** The bot was made (or stopped being) an admin of a channel: remember it as the publishing target. */
export async function handleChannelMembership(
  tg: Telegram,
  db: D1Database,
  update: TgChatMemberUpdated & { chat: { title?: string } },
  admins: Set<number>,
): Promise<void> {
  const status = update.new_chat_member.status;
  const notify = (text: string) => Promise.all([...admins].map((id) => sendMessage(tg, id, text).catch(() => undefined)));
  if (status === "administrator") {
    // Only an admin of this bot may connect a channel; anyone can add a bot to their own channel.
    if (!admins.has(update.from.id)) return;
    const channel: ChannelInfo = { id: update.chat.id, title: update.chat.title ?? String(update.chat.id) };
    await putSetting(db, CHANNEL_SETTING, channel);
    await notify(`✅ Канал «${escapeHtml(channel.title)}» подключён. Посты будут публиковаться туда.`);
    return;
  }
  const current = await getSetting<ChannelInfo>(db, CHANNEL_SETTING);
  if (current?.id === update.chat.id) {
    await db.prepare("DELETE FROM settings WHERE key = ?").bind(CHANNEL_SETTING).run();
    await notify(`⚠️ Бот больше не администратор канала «${escapeHtml(current.title)}». Публикация отключена.`);
  }
}
