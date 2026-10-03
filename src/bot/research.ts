import { activateLeadMagnet, createFunnelForSlug, createLeadMagnetVersion, logAdminAction, nextLeadMagnetVersion } from "../db";
import { enqueueJob } from "../jobs";
import { BRAND_MARK, BRAND_NAME, DEFAULT_CONTENT } from "../pdf/content";
import { calculateBudget, money, validateResearch, type Budget, type ExhibitionResearch } from "../pdf/exhibition";
import type { PdfRenderer } from "../pdf/render";
import { footerTemplate, renderExhibitionHtml } from "../pdf/template";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import type { InlineKeyboard, TgMessage } from "../telegram/types";
import { botUsername, renderMagnet } from "./magnets";
import { createPostDraft } from "./posts";

export const RESEARCH_CALLBACK_PREFIX = "rp:";
export const RENDER_JOB = "RENDER_EXHIBITION_PDF";
const MAX_JSON_BYTES = 1024 * 1024;

interface ResearchRow {
  id: number;
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

function budgetSummary(data: ExhibitionResearch, budget: Budget): string {
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
  const result = validateResearch(raw);
  if (!result.ok) {
    const list = result.errors.slice(0, 15).map((e) => `• ${escapeHtml(e)}`).join("\n");
    const more = result.errors.length > 15 ? `\n…и ещё ${result.errors.length - 15}` : "";
    return void (await sendMessage(tg, chatId, `❌ В research-пакете ошибки, PDF не создан:\n${list}${more}`));
  }
  const id = await queueResearch(tg, db, result.data, chatId, now, "⏳ Research-пакет принят, PDF будет готов через 1–2 минуты.");
  await logAdminAction(db, message.from!.id, "research.upload", now.toISOString(), { id, slug: result.data.slug });
}

/** Stores a valid research package as DRAFT and queues the PDF render; the admin gets the budget summary. */
export async function queueResearch(
  tg: Telegram,
  db: D1Database,
  data: ExhibitionResearch,
  chatId: number,
  now: Date,
  intro: string,
  aiCostUsd = 0,
): Promise<number> {
  const budget = calculateBudget(data);
  const at = now.toISOString();
  const row = await db
    .prepare(
      `INSERT INTO research_items (kind, title, status, research_date, data, calc, slug, ai_cost_usd, created_at, updated_at)
       VALUES ('EXHIBITION', ?1, 'DRAFT', ?2, ?3, ?4, ?5, ?6, ?7, ?7) RETURNING id`,
    )
    .bind(data.title, data.research_date, JSON.stringify(data), JSON.stringify(budget), data.slug, aiCostUsd, at)
    .first<{ id: number }>();
  await enqueueJob(db, RENDER_JOB, { researchId: row!.id, chatId }, at);
  await sendMessage(tg, chatId, `${intro}

${budgetSummary(data, budget)}`);
  return row!.id;
}

/** Cron job: render the PDF, keep the original in R2 and send it to the admin for review. */
export async function runRenderJob(
  deps: { tg: Telegram; db: D1Database; files: R2Bucket; renderPdf: PdfRenderer; now: Date },
  payload: { researchId: number; chatId: number },
): Promise<void> {
  const { tg, db, files } = deps;
  const item = await db.prepare("SELECT * FROM research_items WHERE id = ?").bind(payload.researchId).first<ResearchRow>();
  if (!item || item.status !== "DRAFT") return;
  const data = JSON.parse(item.data) as ExhibitionResearch;
  const budget = calculateBudget(data);
  const brand = { name: BRAND_NAME, mark: BRAND_MARK, botUsername: await botUsername(tg, db) };
  const pdf = await deps.renderPdf(renderExhibitionHtml(data, budget, brand, DEFAULT_CONTENT), footerTemplate(brand, data));

  const r2Key = `research/${item.id}/${data.slug}.pdf`;
  await files.put(r2Key, pdf, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { research_id: String(item.id), slug: data.slug },
  });

  const keyboard: InlineKeyboard = [
    [
      { text: "✅ Одобрить", callback_data: `${RESEARCH_CALLBACK_PREFIX}a:${item.id}` },
      { text: "❌ Отклонить", callback_data: `${RESEARCH_CALLBACK_PREFIX}r:${item.id}` },
    ],
  ];
  const form = new FormData();
  form.set("chat_id", String(payload.chatId));
  form.set("document", new Blob([pdf], { type: "application/pdf" }), `${data.slug}.pdf`);
  form.set("caption", `📄 PDF на проверку\n\n${budgetSummary(data, budget)}\n\nПосле одобрения он станет лид-магнитом.`);
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
      type: "EXHIBITION_GUIDE",
      r2Key: item.pdf_r2_key,
      tgFileId: item.pdf_tg_file_id,
    },
    at,
  );
  await activateLeadMagnet(db, magnet, at);
  const funnel = await createFunnelForSlug(db, magnet.slug, "EXHIBITION", at);
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
