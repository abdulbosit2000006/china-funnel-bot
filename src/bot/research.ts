import { activateLeadMagnet, createFunnelForSlug, createLeadMagnetVersion, logAdminAction, nextLeadMagnetVersion } from "../db";
import { enqueueJob } from "../jobs";
import { BRAND_MARK, BRAND_NAME } from "../pdf/content";
import type { PdfRenderer } from "../pdf/render";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import type { InlineKeyboard, TgMessage } from "../telegram/types";
import { botUsername, renderMagnet } from "./magnets";
import { createPostDraft, fetchPoster } from "./posts";
import { hasSubject, specByResearchKind, subjectSpec, type Researched, type SubjectSpec } from "./subjects";

export const RESEARCH_CALLBACK_PREFIX = "rp:";
export const RENDER_JOB = "RENDER_EXHIBITION_PDF";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_PDF_IMAGE_BYTES = 1024 * 1024;

export interface ResearchRow {
  id: number;
  kind: string;
  auto_date: string | null;
  slug: string;
  title: string;
  status: string;
  data: string;
  pdf_r2_key: string | null;
  pdf_tg_file_id: string | null;
  lead_magnet_id: number | null;
}

export function isResearchFile(message: TgMessage): boolean {
  const doc = message.document;
  if (!doc) return false;
  return doc.mime_type === "application/json" || /\.json$/i.test(doc.file_name ?? "");
}

/** A manufacturing package has `equipment`; everything else is an exhibition package. */
function detectSpec(raw: unknown): SubjectSpec {
  const isManufacturing = typeof raw === "object" && raw !== null && "equipment" in raw;
  return subjectSpec(isManufacturing && hasSubject("MANUFACTURING") ? "MANUFACTURING" : "EXHIBITION");
}

/** Admin sent a research package (JSON): validate, store as DRAFT and queue the PDF render. */
export async function handleResearchUpload(tg: Telegram, db: D1Database, message: TgMessage, now: Date): Promise<void> {
  const doc = message.document!;
  const chatId = message.chat.id;
  if ((doc.file_size ?? 0) > MAX_JSON_BYTES) return void (await sendMessage(tg, chatId, "Файл больше 1 МБ, это не похоже на research-пакет."));
  const file = await tg.call<{ file_path: string }>("getFile", { file_id: doc.file_id });
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await tg.downloadFile(file.file_path)));
  } catch {
    return void (await sendMessage(tg, chatId, "Не удалось прочитать JSON: проверьте, что файл не повреждён."));
  }
  const spec = detectSpec(raw);
  const result = spec.validate(raw);
  if (!result.ok) {
    const list = result.errors.slice(0, 15).map((e) => `• ${escapeHtml(e)}`).join("\n");
    const more = result.errors.length > 15 ? `\n…и ещё ${result.errors.length - 15}` : "";
    return void (await sendMessage(tg, chatId, `❌ В research-пакете ошибки, PDF не создан:\n${list}${more}`));
  }
  const id = await queueResearch(tg, db, spec, result.data, chatId, now, { intro: "⏳ Research-пакет принят, PDF будет готов через 1–2 минуты." });
  await logAdminAction(db, message.from!.id, "research.upload", now.toISOString(), { id, slug: result.data.slug });
}

/**
 * Stores a valid research package as DRAFT and queues the PDF render. The admin gets the summary, except for
 * autopilot packages (autoDate set), which wait quietly for the morning delivery.
 */
export async function queueResearch(
  tg: Telegram,
  db: D1Database,
  spec: SubjectSpec,
  data: Researched,
  chatId: number,
  now: Date,
  opts: { intro: string; aiCostUsd?: number; autoDate?: string; slotId?: number },
): Promise<number> {
  const at = now.toISOString();
  const row = await db
    .prepare(
      `INSERT INTO research_items (kind, title, status, research_date, data, calc, slug, ai_cost_usd, auto_date, slot_id, created_at, updated_at)
       VALUES (?1, ?2, 'DRAFT', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10) RETURNING id`,
    )
    .bind(spec.researchKind, data.title, data.research_date, JSON.stringify(data), JSON.stringify(spec.calc(data)), data.slug, opts.aiCostUsd ?? 0, opts.autoDate ?? null, opts.slotId ?? null, at)
    .first<{ id: number }>();
  await enqueueJob(db, RENDER_JOB, { researchId: row!.id, chatId }, at);
  if (!opts.autoDate) await sendMessage(tg, chatId, `${opts.intro}

${spec.summary(data)}`);
  return row!.id;
}

/** The equipment photo as a data: URI, fetched here so a slow image host cannot stall the PDF render. */
async function pdfImage(fetchUrl: typeof fetch | undefined, url: string | undefined): Promise<string | null> {
  if (!fetchUrl || !url) return null;
  const image = await fetchPoster(fetchUrl, url);
  // Base64 costs CPU time in the Worker; a large photo is not worth it, the PDF just goes without it.
  if (!image || image.bytes.byteLength > MAX_PDF_IMAGE_BYTES) return null;
  let binary = "";
  for (let i = 0; i < image.bytes.length; i += 0x8000) binary += String.fromCharCode(...image.bytes.subarray(i, i + 0x8000));
  return `data:${image.type};base64,${btoa(binary)}`;
}

/** Cron job: render the PDF, keep the original in R2 and send it to the admin for review. */
export async function runRenderJob(
  deps: { tg: Telegram; db: D1Database; files: R2Bucket; renderPdf: PdfRenderer; now: Date; fetchUrl?: typeof fetch },
  payload: { researchId: number; chatId: number },
): Promise<void> {
  const { tg, db, files } = deps;
  const item = await db.prepare("SELECT * FROM research_items WHERE id = ?").bind(payload.researchId).first<ResearchRow>();
  if (!item || item.status !== "DRAFT") return;
  const spec = specByResearchKind(item.kind);
  const data = JSON.parse(item.data) as Researched;
  const brand = { name: BRAND_NAME, mark: BRAND_MARK, botUsername: await botUsername(tg, db) };
  const page = spec.renderPdf(data, brand, await pdfImage(deps.fetchUrl, spec.pdfImageUrl(data)));
  const pdf = await deps.renderPdf(page.html, page.footer);

  const r2Key = `research/${item.id}/${data.slug}.pdf`;
  await files.put(r2Key, pdf, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { research_id: String(item.id), slug: data.slug },
  });

  if (item.auto_date) {
    // Autopilot: the PDF waits in R2; the morning delivery sends it together with the post.
    await db
      .prepare("UPDATE research_items SET status = 'IN_REVIEW', pdf_r2_key = ?, updated_at = ? WHERE id = ?")
      .bind(r2Key, deps.now.toISOString(), item.id)
      .run();
    return;
  }
  const keyboard: InlineKeyboard = [
    [
      { text: "✅ Одобрить", callback_data: `${RESEARCH_CALLBACK_PREFIX}a:${item.id}` },
      { text: "❌ Отклонить", callback_data: `${RESEARCH_CALLBACK_PREFIX}r:${item.id}` },
    ],
  ];
  const form = new FormData();
  form.set("chat_id", String(payload.chatId));
  form.set("document", new Blob([pdf], { type: "application/pdf" }), `${data.slug}.pdf`);
  form.set("caption", `📄 PDF на проверку\n\n${spec.summary(data)}\n\nПосле одобрения он станет лид-магнитом.`);
  form.set("parse_mode", "HTML");
  form.set("reply_markup", JSON.stringify({ inline_keyboard: keyboard }));
  const sent = await tg.upload<{ document?: { file_id: string } }>("sendDocument", form);

  await db
    .prepare("UPDATE research_items SET status = 'IN_REVIEW', pdf_r2_key = ?, pdf_tg_file_id = ?, updated_at = ? WHERE id = ?")
    .bind(r2Key, sent.document?.file_id ?? null, deps.now.toISOString(), item.id)
    .run();
}

export async function handleResearchCallback(
  tg: Telegram,
  db: D1Database,
  callback: { id: string; fromId: number; chatId: number; messageId: number; data: string },
  now: Date,
): Promise<void> {
  const [action, rawId] = callback.data.slice(RESEARCH_CALLBACK_PREFIX.length).split(":");
  const item = await db.prepare("SELECT * FROM research_items WHERE id = ?").bind(Number(rawId)).first<ResearchRow>();
  const at = now.toISOString();
  if (!item || item.status !== "IN_REVIEW") {
    await tg.call("answerCallbackQuery", { callback_query_id: callback.id, text: "Уже обработано." });
    return;
  }
  // Remove the buttons first so a double tap cannot approve twice.
  await tg.call("editMessageReplyMarkup", { chat_id: callback.chatId, message_id: callback.messageId, reply_markup: { inline_keyboard: [] } });

  if (action === "r") {
    await db.prepare("UPDATE research_items SET status = 'REJECTED', updated_at = ? WHERE id = ?").bind(at, item.id).run();
    await logAdminAction(db, callback.fromId, "research.reject", at, { id: item.id });
    await tg.call("answerCallbackQuery", { callback_query_id: callback.id, text: "Отклонено." });
    await sendMessage(tg, callback.chatId, `❌ «${escapeHtml(item.title)}» отклонён. Клиенты его не увидят.`);
    return;
  }
  if (action !== "a" || !item.pdf_tg_file_id || !item.pdf_r2_key) {
    await tg.call("answerCallbackQuery", { callback_query_id: callback.id });
    return;
  }

  const magnet = await createLeadMagnetVersion(
    db,
    {
      slug: item.slug,
      version: await nextLeadMagnetVersion(db, item.slug),
      title: item.title,
      type: specByResearchKind(item.kind).magnetType,
      r2Key: item.pdf_r2_key,
      tgFileId: item.pdf_tg_file_id,
    },
    at,
  );
  await activateLeadMagnet(db, magnet, at);
  const funnel = await createFunnelForSlug(db, magnet.slug, specByResearchKind(item.kind).funnelKind, at);
  await db
    .prepare(
      `UPDATE research_items SET status = 'ACTIVE', approved_at = ?1, approved_by = ?2, lead_magnet_id = ?3, updated_at = ?1
       WHERE id = ?4`,
    )
    .bind(at, callback.fromId, magnet.id, item.id)
    .run();
  await db.prepare("UPDATE lead_magnets SET research_item_id = ?, research_date = (SELECT research_date FROM research_items WHERE id = ?) WHERE id = ?")
    .bind(item.id, item.id, magnet.id)
    .run();
  await logAdminAction(db, callback.fromId, "research.approve", at, { id: item.id, lead_magnet_id: magnet.id });
  await tg.call("answerCallbackQuery", { callback_query_id: callback.id, text: "Одобрено." });
  const fresh = { ...magnet, status: "ACTIVE" as const };
  const view = await renderMagnet(tg, db, fresh);
  await sendMessage(tg, callback.chatId, `✅ Одобрено: PDF стал лид-магнитом, ссылка для поста готова.\n\n${view.text}`, view.keyboard);
  await createPostDraft(tg, db, callback.chatId, fresh, funnel, at);
}
