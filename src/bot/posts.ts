import { createFunnelForSlug, getLeadMagnet, getSetting, logAdminAction, putSetting, type FunnelRow, type LeadMagnetRow } from "../db";
import { enqueueJob } from "../jobs";
import { BRAND_MARK, BRAND_NAME } from "../pdf/content";
import type { ExhibitionResearch } from "../pdf/exhibition";
import { log } from "../log";
import { CARD_HEIGHT, CARD_WIDTH, renderPostCardHtml } from "../pdf/post-card";
import type { ImageRenderer } from "../pdf/render";
import { fmtDate } from "../pdf/template";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import type { InlineKeyboard, TgChatMemberUpdated, TgPhotoSize } from "../telegram/types";
import { botUsername } from "./magnets";

export const POST_CALLBACK_PREFIX = "pp:";
export const CHANNEL_SETTING = "channel";
const EDIT_SETTING = (adminId: number) => `await.post_edit.${adminId}`;
const PHOTO_SETTING = (adminId: number) => `await.post_photo.${adminId}`;
/** Telegram accepts photos up to 10 MB. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
// The price is the reason to open the bot, so the post never shows it (Abdul, 2026-10-03).
const CTA_BUTTON = "💰 Safar narxini bilish";
/** Telegram limit for a photo caption (visible characters). */
export const MAX_CAPTION = 1024;
export const POST_CARD_JOB = "RENDER_POST_CARD";

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
  media: string | null; // JSON {photo_file_id, r2_key}
  channel_message_id: number | null;
}

interface PostMedia {
  photo_file_id: string;
  r2_key: string;
  /** "poster": official image from the organizer, "card": our generated cover, "admin": a photo the admin sent. */
  source?: "poster" | "card" | "admin";
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
  for (const a of attempts) {
    const text = build(a);
    if (visibleLength(text) <= MAX_CAPTION) return text;
  }
  return build(attempts.at(-1)!);
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

/** Drafts a post for an active lead magnet; the cover image is rendered by the cron job, which then sends the preview. */
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
      "INSERT INTO content_items (lead_magnet_id, funnel_id, text, status, created_at) VALUES (?, ?, ?, 'DRAFT', ?) RETURNING id",
    )
    .bind(magnet.id, funnel.id, text, now)
    .first<{ id: number }>();
  await db.prepare("UPDATE funnels SET content_item_id = ? WHERE id = ?").bind(row!.id, funnel.id).run();
  await enqueueJob(db, POST_CARD_JOB, { contentId: row!.id, chatId }, now);
  await sendMessage(tg, chatId, "🎨 Готовлю пост с обложкой, превью придёт через 1–2 минуты.");
}

const POSTER_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png" };

/** Downloads the organizer's official poster. Returns null (and logs why) when it is not a usable photo. */
async function fetchPoster(fetchUrl: typeof fetch, url: string): Promise<{ bytes: Uint8Array; type: string; ext: string } | null> {
  try {
    const res = await fetchUrl(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "image/jpeg,image/png" } });
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!res.ok || !POSTER_TYPES[type]) {
      log.info("post.poster_skipped", { url, status: res.status, type });
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) {
      log.info("post.poster_skipped", { url, bytes: bytes.byteLength });
      return null;
    }
    return { bytes, type, ext: POSTER_TYPES[type]! };
  } catch (error) {
    log.error("post.poster_failed", error, { url });
    return null;
  }
}

/**
 * Cron job: the post photo is the organizer's official poster when research gives one, otherwise our generated cover.
 * The image is kept in R2 and the admin gets the preview photo with the caption.
 */
export async function runPostCardJob(
  deps: { tg: Telegram; db: D1Database; files: R2Bucket; renderImage: ImageRenderer; fetchUrl: typeof fetch },
  payload: { contentId: number; chatId: number },
): Promise<void> {
  const { tg, db, files } = deps;
  const item = await getContent(db, payload.contentId);
  if (!item || item.status !== "DRAFT") return;
  const magnet = (await getLeadMagnet(db, item.lead_magnet_id))!;
  const research = await loadResearch(db, magnet);
  const posterUrl = research?.exhibition.poster_url;
  const poster = posterUrl ? await fetchPoster(deps.fetchUrl, posterUrl) : null;
  let image: { bytes: Uint8Array; type: string; ext: string; source: PostMedia["source"] };
  if (poster) image = { ...poster, source: "poster" };
  else {
    const brand = { name: BRAND_NAME, mark: BRAND_MARK, botUsername: await botUsername(tg, db) };
    const png = await deps.renderImage(renderPostCardHtml(brand, magnet.title, research), CARD_WIDTH, CARD_HEIGHT);
    image = { bytes: png, type: "image/png", ext: "png", source: "card" };
  }
  const r2Key = `posts/${item.id}.${image.ext}`;
  await files.put(r2Key, image.bytes, { httpMetadata: { contentType: image.type } });

  await sendPreviewHeader(tg, db, payload.chatId);
  if (posterUrl && !poster) await sendMessage(tg, payload.chatId, "ℹ️ Официальный постер скачать не удалось, поставил нашу обложку. Можно заменить фото кнопкой «🖼 Заменить фото».");
  const form = new FormData();
  form.set("chat_id", String(payload.chatId));
  form.set("photo", new Blob([image.bytes], { type: image.type }), `post-${item.id}.${image.ext}`);
  form.set("caption", item.text);
  form.set("parse_mode", "HTML");
  form.set("reply_markup", JSON.stringify({ inline_keyboard: await previewKeyboard(tg, db, item) }));
  const sent = await tg.upload<{ photo?: { file_id: string }[] }>("sendPhoto", form);
  const media: PostMedia = { photo_file_id: sent.photo?.at(-1)?.file_id ?? "", r2_key: r2Key, source: image.source };
  await db
    .prepare("UPDATE content_items SET status = 'PREVIEW', media = ? WHERE id = ?")
    .bind(JSON.stringify(media), item.id)
    .run();
}

/** Last resort when the cover could not be rendered: the post goes on as text only. */
export async function postPreviewWithoutPhoto(tg: Telegram, db: D1Database, payload: { contentId: number; chatId: number }): Promise<void> {
  const item = await getContent(db, payload.contentId);
  if (!item || item.status !== "DRAFT") return;
  await db.prepare("UPDATE content_items SET status = 'PREVIEW' WHERE id = ?").bind(item.id).run();
  await sendMessage(tg, payload.chatId, "⚠️ Обложку сделать не удалось, пост будет без картинки.");
  await sendPreview(tg, db, payload.chatId, { ...item, status: "PREVIEW" });
}

async function sendPreviewHeader(tg: Telegram, db: D1Database, chatId: number): Promise<void> {
  const channel = await getSetting<ChannelInfo>(db, CHANNEL_SETTING);
  const where = channel
    ? `Канал: <b>${escapeHtml(channel.title)}</b>`
    : "⚠️ Канал не подключён: добавьте бота администратором канала с правом публикации.";
  await sendMessage(tg, chatId, `📣 <b>Превью поста</b> (так он будет выглядеть в канале)\n${where}`);
}

async function previewKeyboard(tg: Telegram, db: D1Database, item: ContentRow): Promise<InlineKeyboard> {
  return [
    [{ text: CTA_BUTTON, url: await deepLink(tg, db, item.funnel_id) }],
    [
      { text: "✅ Опубликовать", callback_data: `${POST_CALLBACK_PREFIX}p:${item.id}` },
      { text: "✏️ Изменить текст", callback_data: `${POST_CALLBACK_PREFIX}e:${item.id}` },
    ],
    [
      { text: "🖼 Заменить фото", callback_data: `${POST_CALLBACK_PREFIX}i:${item.id}` },
      { text: "❌ Не публиковать", callback_data: `${POST_CALLBACK_PREFIX}x:${item.id}` },
    ],
  ];
}

const photoOf = (item: ContentRow) => (item.media ? (JSON.parse(item.media) as PostMedia).photo_file_id || null : null);

/** Sends the post (photo + caption, or text) with the given keyboard. */
async function sendPost(tg: Telegram, chatId: number, item: ContentRow, keyboard: InlineKeyboard) {
  const photo = photoOf(item);
  const markup = { inline_keyboard: keyboard };
  return photo
    ? tg.call<{ message_id: number }>("sendPhoto", { chat_id: chatId, photo, caption: item.text, parse_mode: "HTML", reply_markup: markup })
    : tg.call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text: item.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: markup,
      });
}

async function sendPreview(tg: Telegram, db: D1Database, chatId: number, item: ContentRow): Promise<void> {
  await sendPreviewHeader(tg, db, chatId);
  await sendPost(tg, chatId, item, await previewKeyboard(tg, db, item));
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

  if (action === "i") {
    await db.prepare("DELETE FROM settings WHERE key = ?").bind(EDIT_SETTING(callback.fromId)).run();
    await putSetting(db, PHOTO_SETTING(callback.fromId), item.id);
    await answer();
    await sendMessage(
      tg,
      callback.chatId,
      "🖼 Пришлите картинку для поста как <b>фото</b> (не файлом), например официальный постер выставки. Текст и кнопка останутся те же.",
    );
    return;
  }
  if (action === "e") {
    await db.prepare("DELETE FROM settings WHERE key = ?").bind(PHOTO_SETTING(callback.fromId)).run();
    await putSetting(db, EDIT_SETTING(callback.fromId), item.id);
    await answer();
    await sendMessage(
      tg,
      callback.chatId,
      `✏️ Пришлите новый текст поста одним сообщением (до ${MAX_CAPTION} символов). Обложка и кнопка останутся те же.`,
    );
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
  let sent: { message_id: number };
  try {
    sent = await sendPost(tg, channel.id, item, [[{ text: CTA_BUTTON, url: await deepLink(tg, db, item.funnel_id) }]]);
  } catch (error) {
    // Only a failed send returns the post to PREVIEW; once Telegram accepted it, it must never be sent again.
    await db.prepare("UPDATE content_items SET status = 'PREVIEW' WHERE id = ?").bind(item.id).run();
    await answer("Telegram не дал опубликовать: проверьте, что бот админ канала с правом публикации.");
    throw error;
  }
  await db
    .prepare("UPDATE content_items SET status = 'PUBLISHED', channel_message_id = ?, published_at = ? WHERE id = ?")
    .bind(sent.message_id ?? null, at, item.id)
    .run();
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
  if (text.trim().length > MAX_CAPTION) {
    await putSetting(db, EDIT_SETTING(adminId), item.id);
    await sendMessage(tg, chatId, `Текст длиннее ${MAX_CAPTION} символов (${text.trim().length}). Сократите и пришлите ещё раз.`);
    return true;
  }
  const newText = escapeHtml(text.trim());
  await db.prepare("UPDATE content_items SET text = ? WHERE id = ?").bind(newText, item.id).run();
  await sendPreview(tg, db, chatId, { ...item, text: newText });
  return true;
}

/** If the admin was asked for a new post photo, use this photo (kept in R2 too). Returns true when consumed. */
export async function handlePostPhoto(
  tg: Telegram,
  db: D1Database,
  files: R2Bucket,
  adminId: number,
  chatId: number,
  photos: TgPhotoSize[],
): Promise<boolean> {
  const itemId = await getSetting<number>(db, PHOTO_SETTING(adminId));
  if (!itemId) return false;
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(PHOTO_SETTING(adminId)).run();
  const item = await getContent(db, itemId);
  const largest = photos.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  if (!item || item.status !== "PREVIEW" || !largest) return false;
  const file = await tg.call<{ file_path: string }>("getFile", { file_id: largest.file_id });
  const r2Key = `posts/${item.id}-admin.jpg`;
  await files.put(r2Key, await tg.downloadFile(file.file_path), { httpMetadata: { contentType: "image/jpeg" } });
  const media: PostMedia = { photo_file_id: largest.file_id, r2_key: r2Key, source: "admin" };
  await db.prepare("UPDATE content_items SET media = ? WHERE id = ?").bind(JSON.stringify(media), item.id).run();
  await sendPreview(tg, db, chatId, { ...item, media: JSON.stringify(media) });
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
