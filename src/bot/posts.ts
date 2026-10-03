import { activateLeadMagnet, archiveLeadMagnet, createFunnelForSlug, getLeadMagnet, getSetting, logAdminAction, putSetting, type FunnelRow, type LeadMagnetRow } from "../db";
import { enqueueJob } from "../jobs";
import { BRAND_MARK, BRAND_NAME } from "../pdf/content";
import { log } from "../log";
import { CARD_HEIGHT, CARD_WIDTH, renderCardHtml } from "../pdf/post-card";
import type { ImageRenderer } from "../pdf/render";
import { fmtDate } from "../pdf/template";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import { MAX_CAPTION, buildPostText, visibleLength } from "./captions";
import { topicKey } from "../content/model";
import type { ContentCtx } from "./plan";
import { specByMagnetType, specByResearchKind, type Researched, type SubjectSpec } from "./subjects";

export { MAX_CAPTION, buildPostText, visibleLength } from "./captions";
import type { InlineKeyboard, TgChatMemberUpdated, TgPhotoSize } from "../telegram/types";
import { botUsername } from "./magnets";

export const POST_CALLBACK_PREFIX = "pp:";
export const CHANNEL_SETTING = "channel";
const EDIT_SETTING = (adminId: number) => `await.post_edit.${adminId}`;
const PHOTO_SETTING = (adminId: number) => `await.post_photo.${adminId}`;
/** Telegram accepts photos up to 10 MB. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
// The price is the reason to open the bot, so the post never shows it (Abdul, 2026-10-03).
const GENERIC_CTA = "📥 Materialni olish";
/** Posts without a PDF send the reader to the bot with a question. */
const QUESTION_CTA = "❓ Savol berish";
const ctaFor = (magnet: LeadMagnetRow | null) => (magnet ? specByMagnetType(magnet.type)?.ctaButton || GENERIC_CTA : QUESTION_CTA);
/** Telegram limit for a text message (a post without a photo). */
const MAX_TEXT = 4096;
const REJECT_REASONS: Record<string, string> = { t: "слабая тема", f: "факты или источники", s: "тон и стиль", l: "не сейчас" };
export const POST_CARD_JOB = "RENDER_POST_CARD";

export interface ChannelInfo {
  id: number;
  title: string;
}

export interface ContentRow {
  id: number;
  /** null for text posts without a PDF. */
  lead_magnet_id: number | null;
  /** null for posts without a link to the bot. */
  funnel_id: number | null;
  text: string;
  status: string;
  media: string | null; // JSON {photo_file_id, r2_key}
  channel_message_id: number | null;
  rubric?: string | null;
  format?: string | null;
  goal?: string | null;
  cta_type?: string | null;
  topic?: string | null;
  series_no?: number | null;
  slot_id?: number | null;
  claims?: string | null;
  poll?: string | null;
  review_note?: string | null;
}

interface PostMedia {
  photo_file_id: string;
  r2_key: string;
  /** "poster": official image from the organizer, "card": our generated cover, "admin": a photo the admin sent. */
  source?: "poster" | "card" | "admin";
}

async function loadResearch(db: D1Database, magnet: LeadMagnetRow): Promise<{ spec: SubjectSpec; data: Researched } | null> {
  const row = await db
    .prepare("SELECT kind, data FROM research_items WHERE id = (SELECT research_item_id FROM lead_magnets WHERE id = ?)")
    .bind(magnet.id)
    .first<{ kind: string; data: string }>();
  return row ? { spec: specByResearchKind(row.kind), data: JSON.parse(row.data) as Researched } : null;
}

export const getContent = (db: D1Database, id: number) =>
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
  opts: { quiet?: boolean } = {},
): Promise<void> {
  const loaded = await loadResearch(db, magnet);
  const isModel = loaded?.spec.subject === "MANUFACTURING";
  const seriesNo = isModel ? await nextSeriesNo(db) : null;
  const text = loaded ? loaded.spec.caption(magnet, loaded.data, { seriesNo }) : buildPostText(magnet, null);
  const slot = await db
    .prepare("SELECT slot_id FROM research_items WHERE id = (SELECT research_item_id FROM lead_magnets WHERE id = ?)")
    .bind(magnet.id)
    .first<{ slot_id: number | null }>();
  // Every PDF post is a lead-generation post of its rubric: Monday business model or Friday exhibition.
  const row = await db
    .prepare(
      `INSERT INTO content_items (lead_magnet_id, funnel_id, text, status, rubric, format, goal, cta_type, topic, topic_key, series_no, slot_id, created_at)
       VALUES (?, ?, ?, 'DRAFT', ?, ?, 'LEAD_GENERATION', 'BOT_PDF', ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      magnet.id,
      funnel.id,
      text,
      isModel ? "BUSINESS_MODEL" : "OPPORTUNITY",
      isModel ? "MANUFACTURING" : loaded ? "EXHIBITION" : null,
      magnet.title,
      topicKey(magnet.title),
      seriesNo,
      slot?.slot_id ?? null,
      now,
    )
    .first<{ id: number }>();
  await db.prepare("UPDATE funnels SET content_item_id = ? WHERE id = ?").bind(row!.id, funnel.id).run();
  if (slot?.slot_id) {
    await db.prepare("UPDATE plan_slots SET content_item_id = ?, status = 'DELIVERED', updated_at = ? WHERE id = ?").bind(row!.id, now, slot.slot_id).run();
  }
  await enqueueJob(db, POST_CARD_JOB, { contentId: row!.id, chatId }, now);
  if (!opts.quiet) await sendMessage(tg, chatId, "🎨 Готовлю пост с обложкой, превью придёт через 1–2 минуты.");
}

/** Next number of the "1 STANOK — 1 BIZNES" series: one more than the last published. */
async function nextSeriesNo(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(MAX(series_no), 0) + 1 AS n FROM content_items WHERE status = 'PUBLISHED' AND rubric = 'BUSINESS_MODEL'")
    .first<{ n: number }>();
  return row?.n ?? 1;
}

export const seriesTag = (n: number) => `#${String(n).padStart(2, "0")}`;

const POSTER_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png" };

/** Downloads the organizer's official poster. Returns null (and logs why) when it is not a usable photo. */
export async function fetchPoster(fetchUrl: typeof fetch, url: string): Promise<{ bytes: Uint8Array; type: string; ext: string } | null> {
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
  if (!item || item.status !== "DRAFT" || !item.lead_magnet_id) return;
  const magnet = (await getLeadMagnet(db, item.lead_magnet_id))!;
  const loaded = await loadResearch(db, magnet);
  const posterUrl = loaded?.spec.posterUrl(loaded.data);
  const poster = posterUrl ? await fetchPoster(deps.fetchUrl, posterUrl) : null;
  let image: { bytes: Uint8Array; type: string; ext: string; source: PostMedia["source"] };
  if (poster) image = { ...poster, source: "poster" };
  else {
    const brand = { name: BRAND_NAME, mark: BRAND_MARK, botUsername: await botUsername(tg, db) };
    const png = await deps.renderImage(renderCardHtml(brand, loaded ? loaded.spec.card(magnet.title, loaded.data) : specByResearchKind("EXHIBITION").card(magnet.title, null)), CARD_WIDTH, CARD_HEIGHT);
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

/** The button under the post in the channel: the PDF, or a question to the bot. None for posts without a link. */
async function ctaRow(tg: Telegram, db: D1Database, item: ContentRow): Promise<InlineKeyboard> {
  if (!item.funnel_id) return [];
  const magnet = item.lead_magnet_id ? await getLeadMagnet(db, item.lead_magnet_id) : null;
  return [[{ text: ctaFor(magnet), url: await deepLink(tg, db, item.funnel_id) }]];
}

async function previewKeyboard(tg: Telegram, db: D1Database, item: ContentRow): Promise<InlineKeyboard> {
  const extra = [{ text: "🔗 Источники", callback_data: `${POST_CALLBACK_PREFIX}s:${item.id}` }];
  // Text posts can be rewritten by the AI; PDF posts are edited by hand.
  if (!item.lead_magnet_id && item.rubric) extra.push({ text: "🔄 Переделать", callback_data: `${POST_CALLBACK_PREFIX}g:${item.id}` });
  return [
    ...(await ctaRow(tg, db, item)),
    [
      { text: "✅ Опубликовать", callback_data: `${POST_CALLBACK_PREFIX}p:${item.id}` },
      { text: "✏️ Изменить текст", callback_data: `${POST_CALLBACK_PREFIX}e:${item.id}` },
    ],
    [
      { text: "🖼 Заменить фото", callback_data: `${POST_CALLBACK_PREFIX}i:${item.id}` },
      { text: "❌ Не публиковать", callback_data: `${POST_CALLBACK_PREFIX}x:${item.id}` },
    ],
    extra,
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

export async function sendPreview(tg: Telegram, db: D1Database, chatId: number, item: ContentRow): Promise<void> {
  await sendPreviewHeader(tg, db, chatId);
  await sendPost(tg, chatId, item, await previewKeyboard(tg, db, item));
}

export async function handlePostCallback(
  tg: Telegram,
  db: D1Database,
  callback: { id: string; fromId: number; chatId: number; messageId: number; data: string },
  now: Date,
  ctx?: ContentCtx,
): Promise<void> {
  const [action, rawId, rawArg] = callback.data.slice(POST_CALLBACK_PREFIX.length).split(":");
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
  if (action === "w" && item) {
    // Why the post was rejected: goes into the next weekly plan and the monthly report.
    const reason = REJECT_REASONS[rawArg ?? ""];
    if (reason) await db.prepare("UPDATE content_items SET reject_reason = ? WHERE id = ? AND status = 'REJECTED'").bind(reason, item.id).run();
    await answer("Спасибо, учту в следующем плане.");
    await tg.call("editMessageReplyMarkup", { chat_id: callback.chatId, message_id: callback.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    return;
  }
  if (action === "s" && item) {
    await answer();
    return void (await sendMessage(tg, callback.chatId, await sourcesText(db, item)));
  }
  if (!item || item.status !== "PREVIEW") return void (await answer("Уже обработано."));
  if (action === "g") {
    await answer();
    if (!ctx || item.lead_magnet_id || !item.rubric) return;
    const { askRegenerate } = await import("./drafts");
    return askRegenerate(ctx, callback.fromId, callback.chatId, item);
  }

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
      `✏️ Пришлите новый текст поста одним сообщением (до ${photoOf(item) ? MAX_CAPTION : MAX_TEXT} символов). Обложка и кнопка останутся те же.`,
    );
    return;
  }
  const clearControls = () =>
    tg.call("editMessageReplyMarkup", {
      chat_id: callback.chatId,
      message_id: callback.messageId,
      reply_markup: { inline_keyboard: [] },
    });

  const magnet = item.lead_magnet_id ? await getLeadMagnet(db, item.lead_magnet_id) : null;
  if (action === "x") {
    await db.prepare("UPDATE content_items SET status = 'REJECTED' WHERE id = ?").bind(item.id).run();
    if (item.slot_id) await db.prepare("UPDATE plan_slots SET status = 'REJECTED', updated_at = ? WHERE id = ?").bind(at, item.slot_id).run();
    // A rejected case post goes back to the founder's review; it was never public.
    await db.prepare("UPDATE content_cases SET status = 'NEEDS_REVIEW', content_item_id = NULL, updated_at = ? WHERE content_item_id = ?").bind(at, item.id).run();
    if (magnet?.status === "DRAFT") {
      // Autopilot bundle: rejecting the post also drops its PDF, which was never live.
      await archiveLeadMagnet(db, magnet.id, at);
      await db.prepare("UPDATE research_items SET status = 'REJECTED', updated_at = ? WHERE lead_magnet_id = ? AND status = 'IN_REVIEW'").bind(at, magnet.id).run();
    }
    await logAdminAction(db, callback.fromId, "post.reject", at, { id: item.id });
    await answer("Не опубликовано.");
    await clearControls();
    await sendMessage(tg, callback.chatId, "Почему не подошёл? Учту в следующем плане (можно не отвечать).", [
      Object.entries(REJECT_REASONS).slice(0, 2).map(([code, text]) => ({ text, callback_data: `${POST_CALLBACK_PREFIX}w:${item.id}:${code}` })),
      Object.entries(REJECT_REASONS).slice(2).map(([code, text]) => ({ text, callback_data: `${POST_CALLBACK_PREFIX}w:${item.id}:${code}` })),
    ]);
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
  if (magnet && magnet.status !== "ACTIVE") {
    // Autopilot bundle: one tap approves the PDF too, so the button works the moment the post is out.
    await activateLeadMagnet(db, magnet, at);
    await db
      .prepare("UPDATE research_items SET status = 'ACTIVE', approved_at = ?1, approved_by = ?2, updated_at = ?1 WHERE lead_magnet_id = ?3 AND status = 'IN_REVIEW'")
      .bind(at, callback.fromId, magnet.id)
      .run();
    await logAdminAction(db, callback.fromId, "research.approve", at, { lead_magnet_id: magnet.id, via: "post" });
  }
  let post = item;
  if (item.rubric === "BUSINESS_MODEL" && item.series_no) {
    // The number is final only now: a rejected draft never takes a number in the series.
    const n = await nextSeriesNo(db);
    if (n !== item.series_no) {
      post = { ...item, series_no: n, text: item.text.replace(seriesTag(item.series_no), seriesTag(n)) };
      await db.prepare("UPDATE content_items SET text = ?, series_no = ? WHERE id = ?").bind(post.text, n, item.id).run();
    }
  }
  let sent: { message_id: number };
  try {
    sent = await sendPost(tg, channel.id, post, await ctaRow(tg, db, post));
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
  if (item.slot_id) await db.prepare("UPDATE plan_slots SET status = 'PUBLISHED', updated_at = ? WHERE id = ?").bind(at, item.slot_id).run();
  await db.prepare("UPDATE content_cases SET status = 'PUBLISHED', updated_at = ? WHERE content_item_id = ?").bind(at, item.id).run();
  const poll = item.poll ? (JSON.parse(item.poll) as { question: string; options: string[] }) : null;
  if (poll) {
    await tg
      .call("sendPoll", { chat_id: channel.id, question: poll.question.slice(0, 300), options: poll.options.slice(0, 10).map((o) => ({ text: String(o).slice(0, 100) })), is_anonymous: true })
      .catch((e) => log.error("post.poll_failed", e, { id: item.id }));
  }
  await answer("Опубликовано.");
  await clearControls();
  await sendMessage(tg, callback.chatId, `✅ Пост опубликован в канале «${escapeHtml(channel.title)}».`);
}

/** "🔗 Источники": every claim of a text post, or the sources of the research behind a PDF post. */
async function sourcesText(db: D1Database, item: ContentRow): Promise<string> {
  const claims = (item.claims ? JSON.parse(item.claims) : []) as {
    text: string; label: string; source_url?: string | null; source_date?: string | null; basis?: string | null; currency?: string | null; unit?: string | null;
  }[];
  if (claims.length) {
    const lines = claims.map((c, i) => {
      const extra = [c.basis, c.currency, c.unit].filter(Boolean).join(", ");
      const src = c.source_url ? `<a href="${escapeHtml(c.source_url)}">источник</a>` : "без источника";
      return `${i + 1}. ${escapeHtml(c.text)}
   ${escapeHtml(c.label)} · ${src}${c.source_date ? ` · ${escapeHtml(c.source_date)}` : ""}${extra ? ` · ${escapeHtml(extra)}` : ""}`;
    });
    return `🔗 <b>Факты и источники поста</b>

${lines.join("\n")}`.slice(0, 4096);
  }
  if (item.lead_magnet_id) {
    const row = await db
      .prepare("SELECT data FROM research_items WHERE id = (SELECT research_item_id FROM lead_magnets WHERE id = ?)")
      .bind(item.lead_magnet_id)
      .first<{ data: string }>();
    const sources = row ? ((JSON.parse(row.data) as { sources?: { id: number; title?: string; url: string }[] }).sources ?? []) : [];
    if (sources.length) {
      return `🔗 <b>Источники research</b> (все цифры в PDF помечены номером источника)

${sources
        .map((s) => `[${s.id}] <a href="${escapeHtml(s.url)}">${escapeHtml(s.title ?? s.url)}</a>`)
        .join("\n")}`.slice(0, 4096);
    }
  }
  return "У этого поста нет списка источников (текст без фактов или загружен вручную).";
}

/** If the admin was asked for a new post text, take this message as that text. Returns true when consumed. */
export async function handlePostEditText(tg: Telegram, db: D1Database, adminId: number, chatId: number, text: string): Promise<boolean> {
  const itemId = await getSetting<number>(db, EDIT_SETTING(adminId));
  if (!itemId) return false;
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(EDIT_SETTING(adminId)).run();
  const item = await getContent(db, itemId);
  if (!item || item.status !== "PREVIEW") return false;
  const limit = photoOf(item) ? MAX_CAPTION : MAX_TEXT;
  if (text.trim().length > limit) {
    await putSetting(db, EDIT_SETTING(adminId), item.id);
    await sendMessage(tg, chatId, `Текст длиннее ${limit} символов (${text.trim().length}). Сократите и пришлите ещё раз.`);
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
  if (visibleLength(item.text) > MAX_CAPTION) {
    await sendMessage(tg, chatId, `С фото Telegram принимает подпись до ${MAX_CAPTION} символов, а в посте ${visibleLength(item.text)}. Сократите текст («✏️ Изменить текст») и пришлите фото ещё раз, или публикуйте без фото.`);
    return true;
  }
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
