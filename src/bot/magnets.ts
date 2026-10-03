import {
  LEAD_MAGNET_TYPES,
  type LeadMagnetRow,
  activateLeadMagnet,
  archiveLeadMagnet,
  createFunnelForSlug,
  createLeadMagnetVersion,
  funnelsForSlug,
  getLeadMagnet,
  getSetting,
  latestLeadMagnet,
  listLeadMagnets,
  logAdminAction,
  nextLeadMagnetVersion,
  putSetting,
  setLeadMagnetType,
} from "../db";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import type { InlineKeyboard, TgMessage } from "../telegram/types";
import { ADMIN_CALLBACK_PREFIX } from "./admin";
import { adminTexts } from "./texts";

export const MAGNET_CALLBACK_PREFIX = "lm:";
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const CAPTION = /^\s*([a-z0-9][a-z0-9-]{1,39})\s*\|\s*(.{2,200}?)\s*$/s;

const TYPE_LABELS: Record<(typeof LEAD_MAGNET_TYPES)[number], string> = {
  EXHIBITION_GUIDE: "Выставка",
  MANUFACTURING_MODEL: "Производство",
  MACHINERY_GUIDE: "Оборудование",
  RAW_MATERIAL_GUIDE: "Сырьё",
};

const FUNNEL_KIND: Record<(typeof LEAD_MAGNET_TYPES)[number], string> = {
  EXHIBITION_GUIDE: "EXHIBITION",
  MANUFACTURING_MODEL: "MANUFACTURING",
  MACHINERY_GUIDE: "MACHINERY",
  RAW_MATERIAL_GUIDE: "RAW_MATERIAL",
};

export function parseCaption(caption: string | undefined): { slug: string; title: string } | null {
  const match = CAPTION.exec(caption ?? "");
  return match ? { slug: match[1]!, title: match[2]! } : null;
}

export async function botUsername(tg: Telegram, db: D1Database): Promise<string> {
  const cached = await getSetting<string>(db, "bot.username");
  if (cached) return cached;
  const me = await tg.call<{ username: string }>("getMe", {});
  await putSetting(db, "bot.username", me.username);
  return me.username;
}

/** Admin sent a PDF: store the original in R2, keep Telegram's file_id for instant delivery. */
export async function handleAdminUpload(
  tg: Telegram,
  db: D1Database,
  files: R2Bucket,
  message: TgMessage,
  now: Date,
): Promise<void> {
  const doc = message.document!;
  const chatId = message.chat.id;
  const isPdf = doc.mime_type ? doc.mime_type === "application/pdf" : /\.pdf$/i.test(doc.file_name ?? "");
  if (!isPdf) return void (await sendMessage(tg, chatId, adminTexts.notPdf));
  if ((doc.file_size ?? 0) > MAX_DOWNLOAD_BYTES) return void (await sendMessage(tg, chatId, adminTexts.tooLarge));
  const parsed = parseCaption(message.caption);
  if (!parsed) return void (await sendMessage(tg, chatId, adminTexts.badCaption));

  const file = await tg.call<{ file_path: string }>("getFile", { file_id: doc.file_id });
  const bytes = await tg.downloadFile(file.file_path);
  const version = await nextLeadMagnetVersion(db, parsed.slug);
  const previous = await latestLeadMagnet(db, parsed.slug);
  const r2Key = `lead-magnets/${parsed.slug}/v${version}.pdf`;
  await files.put(r2Key, bytes, {
    httpMetadata: { contentType: "application/pdf" },
    // No hashing here: on the Workers Free plan (10 ms CPU) hashing a large PDF could hit the limit.
    // Telegram's file_unique_id already identifies the exact file.
    customMetadata: { slug: parsed.slug, version: String(version), tg_file_unique_id: doc.file_unique_id },
  });
  const magnet = await createLeadMagnetVersion(
    db,
    {
      slug: parsed.slug,
      version,
      title: parsed.title,
      type: previous?.type ?? "EXHIBITION_GUIDE",
      r2Key,
      tgFileId: doc.file_id,
    },
    now.toISOString(),
  );
  await logAdminAction(db, message.from!.id, "lead_magnet.upload", now.toISOString(), {
    id: magnet.id,
    slug: magnet.slug,
    version: magnet.version,
  });
  const view = await renderMagnet(tg, db, magnet);
  await sendMessage(tg, chatId, `✅ Загружено.\n\n${view.text}`, view.keyboard);
}

export async function renderMagnet(
  tg: Telegram,
  db: D1Database,
  magnet: LeadMagnetRow,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const funnels = await funnelsForSlug(db, magnet.slug);
  const username = funnels.length ? await botUsername(tg, db) : "";
  const links = funnels
    .map((f) => `• <code>https://t.me/${username}?start=${f.code}</code> (входов: ${f.starts})`)
    .join("\n");
  const text =
    `📄 <b>${escapeHtml(magnet.title)}</b>\n` +
    `slug: <code>${magnet.slug}</code> · версия ${magnet.version}\n` +
    `Тип: ${TYPE_LABELS[magnet.type]} · Статус: <b>${magnet.status}</b>\n\n` +
    (links ? `<b>Ссылки для постов</b>\n${links}` : "Ссылок для постов пока нет.");

  const id = magnet.id;
  const keyboard: InlineKeyboard = [];
  if (magnet.status === "DRAFT") {
    keyboard.push(
      LEAD_MAGNET_TYPES.map((t) => ({
        text: (t === magnet.type ? "• " : "") + TYPE_LABELS[t],
        callback_data: `${MAGNET_CALLBACK_PREFIX}t:${id}:${LEAD_MAGNET_TYPES.indexOf(t)}`,
      })),
    );
    keyboard.push([{ text: "✅ Сделать активной версией", callback_data: `${MAGNET_CALLBACK_PREFIX}a:${id}` }]);
  }
  if (magnet.status === "ACTIVE") {
    keyboard.push([{ text: "📣 Пост для канала", callback_data: `pp:n:${id}` }]);
    keyboard.push([{ text: "🔗 Создать ссылку для поста", callback_data: `${MAGNET_CALLBACK_PREFIX}c:${id}` }]);
  }
  if (magnet.status !== "ARCHIVED") {
    keyboard.push([{ text: "🗑 В архив", callback_data: `${MAGNET_CALLBACK_PREFIX}x:${id}` }]);
  }
  keyboard.push([{ text: adminTexts.back, callback_data: ADMIN_CALLBACK_PREFIX + "magnets" }]);
  return { text, keyboard };
}

export async function renderMagnetList(db: D1Database): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const magnets = await listLeadMagnets(db);
  const keyboard: InlineKeyboard = magnets.map((m) => [
    {
      text: `${m.status === "ACTIVE" ? "🟢" : m.status === "DRAFT" ? "📝" : "⚪️"} ${m.title.slice(0, 40)} · v${m.version} · ${m.deliveries}↓`,
      callback_data: `${MAGNET_CALLBACK_PREFIX}v:${m.id}`,
    },
  ]);
  keyboard.push([{ text: adminTexts.back, callback_data: ADMIN_CALLBACK_PREFIX + "menu" }]);
  const text = magnets.length
    ? `📄 <b>Lead Magnets</b>\n🟢 активна · 📝 черновик · ⚪️ устарела · ↓ выдано\n\n${adminTexts.uploadHelp}`
    : `📄 <b>Lead Magnets</b>\n\nПока пусто.\n\n${adminTexts.uploadHelp}`;
  return { text, keyboard };
}

export async function handleMagnetCallback(
  tg: Telegram,
  db: D1Database,
  callback: { id: string; fromId: number; chatId: number; messageId: number; data: string },
  now: Date,
): Promise<void> {
  const [action, rawId, rawArg] = callback.data.slice(MAGNET_CALLBACK_PREFIX.length).split(":");
  const magnet = await getLeadMagnet(db, Number(rawId));
  let notice: string | undefined;
  if (magnet) {
    const at = now.toISOString();
    if (action === "t" && magnet.status === "DRAFT") {
      const type = LEAD_MAGNET_TYPES[Number(rawArg)];
      if (type) await setLeadMagnetType(db, magnet.id, type, at);
    } else if (action === "a" && magnet.status === "DRAFT") {
      await activateLeadMagnet(db, magnet, at);
      notice = "Версия активна: клиенты получают её по ссылкам.";
    } else if (action === "c" && magnet.status === "ACTIVE") {
      const funnel = await createFunnelForSlug(db, magnet.slug, FUNNEL_KIND[magnet.type], at);
      notice = `Ссылка создана: ${funnel.code}`;
    } else if (action === "x") {
      await archiveLeadMagnet(db, magnet.id, at);
      notice = "Отправлено в архив.";
    }
    if (action !== "v") {
      await logAdminAction(db, callback.fromId, `lead_magnet.${action}`, at, { id: magnet.id, arg: rawArg });
    }
  }
  await tg.call("answerCallbackQuery", { callback_query_id: callback.id, ...(notice ? { text: notice } : {}) });
  const fresh = magnet ? await getLeadMagnet(db, magnet.id) : null;
  const view = fresh ? await renderMagnet(tg, db, fresh) : await renderMagnetList(db);
  await tg.call("editMessageText", {
    chat_id: callback.chatId,
    message_id: callback.messageId,
    text: view.text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: view.keyboard },
  });
}
