// Real cases (Wednesday trust rubric). The founder sends notes, voice messages and photos after /case;
// the AI writes an anonymised post, our code still looks for phones, links and sums, and the founder marks
// the case safe. Only SAFE_TO_USE cases go to the plan (slotCaseItem in drafts.ts).
import { TRANSCRIBE_USD_PER_MINUTE, extractJson, outputText } from "../ai/openai";
import { casePrompt } from "../ai/prompts-content";
import { getSetting, logAdminAction, putSetting } from "../db";
import { findCliches, findPrivateData } from "../content/model";
import { log } from "../log";
import { escapeHtml, sendMessage } from "../telegram/api";
import type { InlineKeyboard, TgMessage } from "../telegram/types";
import { costLine, queueRun, updateRun, type RunHandler } from "./ai";
import { budgetAllows } from "./budget";
import { CLICHE_SETTING } from "./drafts";
import type { ContentCtx } from "./plan";

export const CASE_CALLBACK_PREFIX = "cs:";
const COLLECT_SETTING = (adminId: number) => `await.case.${adminId}`;
const EDIT_SETTING = (adminId: number) => `await.case_edit.${adminId}`;
/** Longer voice notes are better split: the transcription call has to finish inside the webhook. */
const MAX_VOICE_SECONDS = 300;
const MAX_NOTES = 30;

interface CaseNote {
  type: "text" | "voice" | "photo";
  text?: string;
  file_id?: string;
}

interface CaseRow {
  id: number;
  status: string;
  notes: string;
  draft: string | null;
  redactions: string | null;
  warnings: string | null;
  photo_file_id: string | null;
  content_item_id: number | null;
  created_at: string;
}

const STATUS_RU: Record<string, string> = {
  COLLECTING: "собираю заметки",
  DRAFTING: "пишу текст",
  DRAFT: "черновик",
  NEEDS_REVIEW: "⚠️ проверить",
  SAFE_TO_USE: "✅ в очереди на среду",
  PUBLISHED: "опубликован",
};

const getCase = (db: D1Database, id: number) => db.prepare("SELECT * FROM content_cases WHERE id = ?").bind(id).first<CaseRow>();
const notesOf = (row: CaseRow) => JSON.parse(row.notes || "[]") as CaseNote[];

/** /case: start collecting notes about one client story. */
export async function startCase(ctx: ContentCtx, chatId: number, adminId: number): Promise<void> {
  const at = ctx.now.toISOString();
  const open = await getSetting<number>(ctx.db, COLLECT_SETTING(adminId));
  const existing = open ? await getCase(ctx.db, open) : null;
  const id =
    existing?.status === "COLLECTING"
      ? existing.id
      : (await ctx.db.prepare("INSERT INTO content_cases (status, notes, created_at, updated_at) VALUES ('COLLECTING', '[]', ?, ?) RETURNING id").bind(at, at).first<{ id: number }>())!.id;
  await putSetting(ctx.db, COLLECT_SETTING(adminId), id);
  await sendMessage(
    ctx.tg,
    chatId,
    `📁 <b>Кейс №${id}</b>${existing?.status === "COLLECTING" ? " (продолжаем)" : ""}\n` +
      "Расскажите историю клиента: текстом, голосовыми (расшифрую), можно фото с завода или выставки. Сколько угодно сообщений.\n\n" +
      "Не бойтесь деталей: имена, компании, телефоны и точные суммы я уберу из поста, а перед публикацией вы всё проверите.\n\n" +
      "Когда закончите, нажмите «✅ Готово».",
    caseCollectKeyboard(id),
  );
}

function caseCollectKeyboard(id: number): InlineKeyboard {
  return [[
    { text: "✅ Готово", callback_data: `${CASE_CALLBACK_PREFIX}d:${id}` },
    { text: "✖️ Отмена", callback_data: `${CASE_CALLBACK_PREFIX}c:${id}` },
  ]];
}

/** Turns a voice message into text; the cost is recorded in ai_runs so the monthly budget sees it. */
async function transcribeVoice(ctx: ContentCtx, chatId: number, voice: NonNullable<TgMessage["voice"]>): Promise<string | null> {
  if (!ctx.ai?.transcribe) {
    await sendMessage(ctx.tg, chatId, "⏸ Расшифровка голосовых сейчас недоступна (AI на паузе или нет ключа OpenAI). Напишите текстом, пожалуйста.");
    return null;
  }
  if (voice.duration > MAX_VOICE_SECONDS) {
    await sendMessage(ctx.tg, chatId, `Голосовое длиннее ${MAX_VOICE_SECONDS / 60} минут, разбейте его на несколько, пожалуйста.`);
    return null;
  }
  if (!(await budgetAllows(ctx.tg, ctx.db, chatId, ctx.now))) return null;
  const file = await ctx.tg.call<{ file_path?: string }>("getFile", { file_id: voice.file_id });
  if (!file.file_path) throw new Error("Telegram не отдал файл голосового");
  const bytes = await ctx.tg.downloadFile(file.file_path);
  const text = (await ctx.ai.transcribe(new Blob([bytes], { type: voice.mime_type ?? "audio/ogg" }), "voice.ogg")).trim();
  const at = ctx.now.toISOString();
  const cost = Math.ceil(voice.duration / 60) * TRANSCRIBE_USD_PER_MINUTE;
  await ctx.db
    .prepare("INSERT INTO ai_runs (kind, status, request, chat_id, model, extra_cost_usd, created_at, updated_at) VALUES ('TRANSCRIBE', 'DONE', ?, ?, 'transcribe', ?, ?, ?)")
    .bind(JSON.stringify({ seconds: voice.duration }), chatId, cost, at, at)
    .run();
  return text;
}

/**
 * Text, photo or voice while a case is being collected. Returns true when the message was consumed.
 * A voice message outside /case gets a hint instead of the generic fallback.
 */
export async function handleCaseMessage(ctx: ContentCtx, adminId: number, chatId: number, message: TgMessage): Promise<boolean> {
  const id = await getSetting<number>(ctx.db, COLLECT_SETTING(adminId));
  const row = id ? await getCase(ctx.db, id) : null;
  if (!row || row.status !== "COLLECTING") {
    if (!message.voice) return false;
    await sendMessage(ctx.tg, chatId, "🎙 Голосовые я расшифровываю для кейсов. Начните кейс командой /case и пришлите голосовое ещё раз.");
    return true;
  }
  const notes = notesOf(row);
  if (notes.length >= MAX_NOTES) {
    await sendMessage(ctx.tg, chatId, "Заметок уже много, нажмите «✅ Готово».", caseCollectKeyboard(row.id));
    return true;
  }
  let photo = row.photo_file_id;
  if (message.voice) {
    let text: string | null;
    try {
      text = await transcribeVoice(ctx, chatId, message.voice);
    } catch (error) {
      log.error("case.transcribe_failed", error, { case: row.id });
      await sendMessage(ctx.tg, chatId, "⚠️ Не получилось расшифровать голосовое. Попробуйте ещё раз или напишите текстом.");
      return true;
    }
    if (!text) return true;
    notes.push({ type: "voice", text });
    await sendMessage(ctx.tg, chatId, `🎙 Расшифровал:\n<i>${escapeHtml(text.slice(0, 1500))}</i>`, caseCollectKeyboard(row.id));
  } else if (message.photo?.length) {
    const best = message.photo[message.photo.length - 1]!;
    photo = photo ?? best.file_id;
    notes.push({ type: "photo", file_id: best.file_id, ...(message.caption ? { text: message.caption } : {}) });
    await sendMessage(ctx.tg, chatId, `📷 Фото добавил${photo === best.file_id ? " (пойдёт в пост)" : ""}.`, caseCollectKeyboard(row.id));
  } else if (message.text) {
    notes.push({ type: "text", text: message.text.slice(0, 4000) });
    await sendMessage(ctx.tg, chatId, `📝 Записал (заметок: ${notes.length}).`, caseCollectKeyboard(row.id));
  } else {
    return false;
  }
  await ctx.db
    .prepare("UPDATE content_cases SET notes = ?, photo_file_id = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(notes), photo, ctx.now.toISOString(), row.id)
    .run();
  return true;
}

export const caseHandler: RunHandler = {
  webSearch: false,
  async prompt(db, run, request) {
    const row = await getCase(db, Number(request.caseId));
    const notes = row ? notesOf(row).map((n) => n.text).filter((t): t is string => Boolean(t?.trim())) : [];
    return casePrompt(notes);
  },
  async finish(ctx, run, res) {
    const caseId = Number((JSON.parse(run.request) as { caseId: number }).caseId);
    const raw = extractJson(outputText(res)) as { text?: unknown; topic?: unknown; redactions?: unknown } | null;
    const text = typeof raw?.text === "string" ? raw.text.trim() : "";
    const errors: string[] = [];
    if (text.length < 200) errors.push("text: пост слишком короткий (меньше 200 символов)");
    if (text.length > 3500) errors.push(`text: ${text.length} символов, нужно не больше 3500`);
    if (/<(?!\/?(b|i|u|s|code)\b)[^>]*>/i.test(text)) errors.push("text: допустимы только теги <b>, <i>, <u>, <s>, <code> (ссылок в кейсе быть не должно)");
    const cliches = findCliches(text, (await getSetting<string[]>(ctx.db, CLICHE_SETTING)) ?? []);
    if (cliches.length) errors.push(`text: убери шаблонные фразы: ${cliches.join("; ")}`);
    if (errors.length) return errors;
    const redactions = Array.isArray(raw?.redactions) ? raw!.redactions.filter((r): r is string => typeof r === "string").slice(0, 10) : [];
    const warnings = findPrivateData(text.replace(/<[^>]+>/g, ""));
    await ctx.db
      .prepare("UPDATE content_cases SET status = ?, draft = ?, redactions = ?, warnings = ?, updated_at = ? WHERE id = ?")
      .bind(warnings.length ? "NEEDS_REVIEW" : "DRAFT", text, JSON.stringify(redactions), JSON.stringify(warnings), ctx.now.toISOString(), caseId)
      .run();
    await updateRun(ctx.db, run.id, { status: "DONE", result: JSON.stringify({ case: caseId }) }, ctx.now);
    const row = await getCase(ctx.db, caseId);
    if (row) await sendCaseCard(ctx, run.chat_id, row, costLine(run));
  },
};

function caseCard(row: CaseRow, footer = ""): { text: string; keyboard: InlineKeyboard } {
  const redactions = JSON.parse(row.redactions ?? "[]") as string[];
  const warnings = JSON.parse(row.warnings ?? "[]") as string[];
  const lines = [
    `📁 <b>Кейс №${row.id}</b> · ${STATUS_RU[row.status] ?? row.status}`,
    redactions.length ? `🙈 Убрал: ${escapeHtml(redactions.join("; "))}` : "",
    warnings.length
      ? `⚠️ В тексте ещё есть: ${escapeHtml(warnings.join("; "))}. Проверьте, что это можно показывать, или исправьте.`
      : "✅ Телефонов, ников, ссылок и сумм в тексте не нашёл.",
    "",
    row.draft ?? "",
    footer ? `\n${footer}` : "",
  ].filter((l, i) => l || i === 3);
  const keyboard: InlineKeyboard = [
    [{ text: "✅ Можно публиковать", callback_data: `${CASE_CALLBACK_PREFIX}s:${row.id}` }],
    [
      { text: "✏️ Исправить текст", callback_data: `${CASE_CALLBACK_PREFIX}e:${row.id}` },
      { text: "🗑 Удалить", callback_data: `${CASE_CALLBACK_PREFIX}x:${row.id}` },
    ],
  ];
  return { text: lines.join("\n").slice(0, 4096), keyboard };
}

async function sendCaseCard(ctx: ContentCtx, chatId: number, row: CaseRow, footer = ""): Promise<void> {
  const { text, keyboard } = caseCard(row, footer);
  await sendMessage(ctx.tg, chatId, text, keyboard);
}

export async function handleCaseCallback(ctx: ContentCtx, callback: { id: string; fromId: number; chatId: number; messageId: number; data: string }) {
  const [action, rawId] = callback.data.slice(CASE_CALLBACK_PREFIX.length).split(":");
  const answer = (text?: string) => ctx.tg.call("answerCallbackQuery", { callback_query_id: callback.id, ...(text ? { text } : {}) });
  const row = await getCase(ctx.db, Number(rawId));
  if (!row || row.status === "DELETED") return void (await answer("Кейс не найден."));
  const at = ctx.now.toISOString();

  if (action === "c") {
    await ctx.db.prepare("DELETE FROM settings WHERE key = ?").bind(COLLECT_SETTING(callback.fromId)).run();
    if (row.status === "COLLECTING") await ctx.db.prepare("UPDATE content_cases SET status = 'DELETED', updated_at = ? WHERE id = ?").bind(at, row.id).run();
    await answer("Отменено.");
    return;
  }
  if (action === "d") {
    if (row.status !== "COLLECTING") return void (await answer("Уже отправлено."));
    if (!notesOf(row).some((n) => n.text?.trim())) return void (await answer("Сначала пришлите хотя бы одну заметку текстом или голосом."));
    await ctx.db.prepare("UPDATE content_cases SET status = 'DRAFTING', updated_at = ? WHERE id = ?").bind(at, row.id).run();
    const run = await queueRun(ctx.tg, ctx.db, ctx.ai, callback.chatId, callback.fromId, "CASE", { caseId: row.id }, ctx.now);
    if (run === null) {
      await ctx.db.prepare("UPDATE content_cases SET status = 'COLLECTING', updated_at = ? WHERE id = ?").bind(at, row.id).run();
      return void (await answer());
    }
    await ctx.db.prepare("DELETE FROM settings WHERE key = ?").bind(COLLECT_SETTING(callback.fromId)).run();
    await answer("Принято.");
    await sendMessage(ctx.tg, callback.chatId, `✍️ Пишу пост по кейсу №${row.id} и убираю личные данные. Пришлю черновик через пару минут.`);
    return;
  }
  if (action === "s") {
    if (!row.draft || !["DRAFT", "NEEDS_REVIEW"].includes(row.status)) return void (await answer("Этот кейс уже обработан."));
    await ctx.db.prepare("UPDATE content_cases SET status = 'SAFE_TO_USE', updated_at = ? WHERE id = ?").bind(at, row.id).run();
    await logAdminAction(ctx.db, callback.fromId, "case.safe", at, { id: row.id, warnings: JSON.parse(row.warnings ?? "[]") });
    await answer("Сохранено.");
    await sendMessage(ctx.tg, callback.chatId, `✅ Кейс №${row.id} в очереди. Он пойдёт в ближайшую среду вместо AI-темы; перед публикацией вы ещё раз увидите превью.`);
    return;
  }
  if (action === "e") {
    if (!row.draft || !["DRAFT", "NEEDS_REVIEW"].includes(row.status)) return void (await answer("Этот кейс уже обработан."));
    await putSetting(ctx.db, EDIT_SETTING(callback.fromId), row.id);
    await answer();
    await sendMessage(ctx.tg, callback.chatId, "✏️ Пришлите исправленный текст поста целиком одним сообщением.");
    return;
  }
  if (action === "v") {
    await answer();
    return showCase(ctx, callback.chatId, row.id);
  }
  if (action === "x") {
    await ctx.db.prepare("UPDATE content_cases SET status = 'DELETED', updated_at = ? WHERE id = ?").bind(at, row.id).run();
    await logAdminAction(ctx.db, callback.fromId, "case.delete", at, { id: row.id });
    await answer("Удалено.");
    await ctx.tg.call("editMessageReplyMarkup", { chat_id: callback.chatId, message_id: callback.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    return;
  }
  await answer();
}

/** The founder's own version of the case text. Returns true when the text was consumed. */
export async function handleCaseEditText(ctx: ContentCtx, adminId: number, chatId: number, text: string): Promise<boolean> {
  const id = await getSetting<number>(ctx.db, EDIT_SETTING(adminId));
  if (!id) return false;
  await ctx.db.prepare("DELETE FROM settings WHERE key = ?").bind(EDIT_SETTING(adminId)).run();
  const row = await getCase(ctx.db, id);
  if (!row || !["DRAFT", "NEEDS_REVIEW"].includes(row.status)) return false;
  const draft = text.trim().slice(0, 3500);
  const warnings = findPrivateData(draft.replace(/<[^>]+>/g, ""));
  await ctx.db
    .prepare("UPDATE content_cases SET draft = ?, warnings = ?, status = ?, updated_at = ? WHERE id = ?")
    .bind(draft, JSON.stringify(warnings), warnings.length ? "NEEDS_REVIEW" : "DRAFT", ctx.now.toISOString(), row.id)
    .run();
  const updated = await getCase(ctx.db, row.id);
  await sendCaseCard(ctx, chatId, updated!);
  return true;
}

/** /cases: the case base with statuses. */
export async function listCases(ctx: ContentCtx, chatId: number): Promise<void> {
  const rows = (await ctx.db.prepare("SELECT * FROM content_cases WHERE status != 'DELETED' ORDER BY id DESC LIMIT 20").all<CaseRow>()).results;
  if (!rows.length) {
    return void (await sendMessage(ctx.tg, chatId, "📁 Кейсов пока нет. Начните командой /case и расскажите историю клиента."));
  }
  const lines = rows.map((r) => {
    const first = (r.draft ?? notesOf(r).find((n) => n.text)?.text ?? "").replace(/<[^>]+>/g, "").split("\n").find((l) => l.trim()) ?? "";
    return `№${r.id} · ${STATUS_RU[r.status] ?? r.status} · ${escapeHtml(first.slice(0, 60))}`;
  });
  const review = rows.filter((r) => r.status === "DRAFT" || r.status === "NEEDS_REVIEW");
  const keyboard: InlineKeyboard = review.slice(0, 5).map((r) => [{ text: `Открыть №${r.id}`, callback_data: `${CASE_CALLBACK_PREFIX}v:${r.id}` }]);
  await sendMessage(ctx.tg, chatId, `📁 <b>Кейсы</b>\n\n${lines.join("\n")}\n\nНовый кейс: /case`, keyboard.length ? keyboard : undefined);
}

/** "Открыть №N" from /cases. */
export async function showCase(ctx: ContentCtx, chatId: number, id: number): Promise<void> {
  const row = await getCase(ctx.db, id);
  if (row?.draft) await sendCaseCard(ctx, chatId, row);
}
