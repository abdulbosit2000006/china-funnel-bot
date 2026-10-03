// Text posts without a PDF (Wed trust, Fri machine/raw material/trend, Sun insight, BREAKING, cases).
// The AI drafts, our code checks claims, clichés and limits; the founder previews and publishes with one tap.
import { extractJson, outputText, seenUrls } from "../ai/openai";
import { draftPrompt } from "../ai/prompts-content";
import { getSetting, logAdminAction, putSetting, type FunnelRow } from "../db";
import { DEFAULT_CLICHES, RUBRIC_RU, checkDraft, topicKey, type Rubric, type TextDraft, type TopicCandidate } from "../content/model";
import { dayShort } from "../content/calendar";
import { escapeHtml, sendMessage } from "../telegram/api";
import { visibleLength, MAX_CAPTION } from "./captions";
import { costLine, queueRun, updateRun, type RunHandler } from "./ai";
import type { ContentCtx, SlotRow } from "./plan";
import { getContent, sendPreview, type ContentRow } from "./posts";

export const CLICHE_SETTING = "content.cliches";
const REGEN_SETTING = (adminId: number) => `await.regenerate.${adminId}`;

interface DraftRequest {
  rubric: Rubric;
  idea?: TopicCandidate | null;
  questions?: string[];
  comment?: string;
  /** BREAKING: the founder's link or text. */
  input?: string;
}

async function cliches(db: D1Database): Promise<string[]> {
  const extra = (await getSetting<string[]>(db, CLICHE_SETTING)) ?? [];
  return [...DEFAULT_CLICHES, ...extra.filter((x) => typeof x === "string" && x.trim())];
}

/** Questions clients asked the bot this week (texts only, no names) for the Sunday insight. */
export async function weekQuestions(db: D1Database, now: Date): Promise<string[]> {
  const rows = await db
    .prepare("SELECT payload FROM funnel_events WHERE type = 'FOLLOWUP_REPLY' AND created_at >= ? ORDER BY id DESC LIMIT 30")
    .bind(new Date(now.getTime() - 7 * 86_400_000).toISOString())
    .all<{ payload: string | null }>();
  return rows.results
    .map((r) => (r.payload ? (JSON.parse(r.payload) as { text?: string }).text : undefined))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 5)
    .map((t) => t.replace(/\+?\d[\d\s()-]{7,}\d/g, "…").replace(/@\w+/g, "…").slice(0, 200))
    .slice(0, 10);
}

/** A campaign link without a PDF: the reader lands in the bot and is asked for their question. */
export async function createQuestionFunnel(db: D1Database, topic: string, now: string): Promise<FunnelRow> {
  const base = (topicKey(topic).replace(/-/g, "_").slice(0, 40) || "post").replace(/[^A-Za-z0-9_]/g, "") || "post";
  const { n } = (await db.prepare("SELECT COUNT(*) AS n FROM funnels WHERE code LIKE ?").bind(`q_${base}%`).first<{ n: number }>()) ?? { n: 0 };
  const row = await db
    .prepare("INSERT INTO funnels (code, kind, lead_magnet_slug, created_at) VALUES (?, 'GENERAL', NULL, ?) RETURNING id, code, kind, lead_magnet_slug")
    .bind(`q_${base}_${n + 1}`.slice(0, 64), now)
    .first<FunnelRow>();
  return row!;
}

export async function createTextItem(
  db: D1Database,
  args: {
    text: string;
    rubric: Rubric;
    format: string;
    goal: string;
    cta: string;
    topic: string;
    claims?: unknown[];
    poll?: unknown;
    reviewNote?: string;
    slotId?: number | null;
    photoFileId?: string | null;
  },
  now: string,
): Promise<number> {
  const funnel = args.cta === "BOT_QUESTION" ? await createQuestionFunnel(db, args.topic, now) : null;
  const media = args.photoFileId ? JSON.stringify({ photo_file_id: args.photoFileId, r2_key: "", source: "admin" }) : null;
  const row = await db
    .prepare(
      `INSERT INTO content_items (lead_magnet_id, funnel_id, text, media, status, rubric, format, goal, cta_type, topic, topic_key, slot_id, claims, poll, review_note, created_at)
       VALUES (NULL, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      funnel?.id ?? null,
      args.text,
      media,
      args.rubric,
      args.format,
      args.goal,
      args.cta,
      args.topic,
      topicKey(args.topic),
      args.slotId ?? null,
      JSON.stringify(args.claims ?? []),
      args.poll ? JSON.stringify(args.poll) : null,
      args.reviewNote ?? null,
      now,
    )
    .first<{ id: number }>();
  if (funnel) await db.prepare("UPDATE funnels SET content_item_id = ? WHERE id = ?").bind(row!.id, funnel.id).run();
  return row!.id;
}

/** Sends a text draft to the founder: a short header, the checks, then the preview with buttons. */
export async function deliverTextItem(ctx: ContentCtx, chatId: number, itemId: number, header: string): Promise<void> {
  const item = await getContent(ctx.db, itemId);
  if (!item || item.status !== "DRAFT") return;
  await ctx.db.prepare("UPDATE content_items SET status = 'PREVIEW' WHERE id = ?").bind(item.id).run();
  await sendMessage(ctx.tg, chatId, `${header}${item.review_note ? `\n\n${item.review_note}` : ""}`);
  await sendPreview(ctx.tg, ctx.db, chatId, { ...item, status: "PREVIEW" });
}

/** Morning delivery of a ready slot. */
export async function deliverSlotPost(ctx: ContentCtx, chatId: number, slot: SlotRow): Promise<void> {
  const item = await getContent(ctx.db, slot.content_item_id!);
  const what = item?.format === "REAL_CASE" ? "реальный кейс из вашей базы" : `${RUBRIC_RU[slot.rubric]}${item?.format ? `, ${item.format}` : ""}`;
  await deliverTextItem(
    ctx,
    chatId,
    slot.content_item_id!,
    `☀️ <b>Пост на сегодня</b> (${dayShort(slot.slot_date)} · ${escapeHtml(what)})\nПроверьте текст и источники (кнопка «🔗 Источники»), затем <b>✅ Опубликовать</b>.`,
  );
}

/** Wednesday: a case the founder marked safe goes first, without AI. */
export async function slotCaseItem(ctx: ContentCtx, slot: SlotRow): Promise<boolean> {
  const found = await ctx.db
    .prepare("SELECT id, draft, photo_file_id FROM content_cases WHERE status = 'SAFE_TO_USE' AND content_item_id IS NULL ORDER BY id LIMIT 1")
    .first<{ id: number; draft: string; photo_file_id: string | null }>();
  if (!found) return false;
  const at = ctx.now.toISOString();
  const photo = found.photo_file_id && visibleLength(found.draft) <= MAX_CAPTION ? found.photo_file_id : null;
  const firstLine = found.draft.replace(/<[^>]+>/g, "").split("\n").find((l) => l.trim()) ?? "keys";
  const itemId = await createTextItem(
    ctx.db,
    { text: found.draft, rubric: "TRUST", format: "REAL_CASE", goal: "TRUST", cta: "BOT_QUESTION", topic: firstLine.slice(0, 120), slotId: slot.id, photoFileId: photo },
    at,
  );
  await ctx.db.batch([
    ctx.db.prepare("UPDATE content_cases SET content_item_id = ?, updated_at = ? WHERE id = ?").bind(itemId, at, found.id),
    ctx.db.prepare("UPDATE plan_slots SET status = 'READY', content_item_id = ?, updated_at = ? WHERE id = ?").bind(itemId, at, slot.id),
  ]);
  return true;
}

export const draftHandler: RunHandler = {
  webSearch: true,
  async prompt(db, run, request, now) {
    const r = request as unknown as DraftRequest;
    const c = r.idea;
    return draftPrompt(now.toISOString().slice(0, 10), r.rubric, {
      topic: c?.topic ?? r.input ?? "события недели",
      format: c?.format,
      benefit: c?.benefit,
      hook: c?.hook,
      angle: c?.angle,
      source_urls: c?.source_urls,
      comment: r.comment,
      questions: r.questions,
    });
  },
  async finish(ctx, run, res) {
    const r = JSON.parse(run.request) as DraftRequest;
    const checked = checkDraft(extractJson(outputText(res)), r.rubric, seenUrls(res), await cliches(ctx.db));
    if (!checked.ok) return checked.errors;
    const at = ctx.now.toISOString();
    const draft: TextDraft = checked.draft;
    const quiet = { disable_notification: true };
    if (draft.skip) {
      await updateRun(ctx.db, run.id, { status: "DONE", result: JSON.stringify({ skip: draft.skip }) }, ctx.now);
      if (run.slot_id) {
        await ctx.db.prepare("UPDATE plan_slots SET status = 'SKIPPED', note = ?, updated_at = ? WHERE id = ?").bind(draft.skip.slice(0, 300), at, run.slot_id).run();
      }
      const what = r.rubric === "BREAKING" ? "⚡️ BREAKING-пост не стал писать" : `⏭ ${RUBRIC_RU[r.rubric]}: пропускаем, сильной темы нет`;
      await ctx.tg.call("sendMessage", { chat_id: run.chat_id, text: `${what}: ${escapeHtml(draft.skip)}`, parse_mode: "HTML", ...(r.rubric === "BREAKING" ? {} : quiet) });
      return;
    }
    const warnings = checked.warnings.map((w) => `⚠️ ${escapeHtml(w)}`);
    const reviewNote = [...warnings, warnings.length ? "" : "✅ Все цифры с источниками из поиска.", costLine(run)].filter(Boolean).join("\n");
    const itemId = await createTextItem(
      ctx.db,
      {
        text: draft.text,
        rubric: r.rubric,
        format: draft.format,
        goal: draft.goal,
        cta: draft.cta_type,
        topic: r.idea?.topic ?? draft.topic,
        claims: draft.claims,
        poll: draft.poll,
        reviewNote,
        slotId: run.slot_id,
      },
      at,
    );
    await updateRun(ctx.db, run.id, { status: "DONE", result: JSON.stringify({ content_item_id: itemId }) }, ctx.now);
    if (run.slot_id) {
      // The planner delivers it at 09:00 on the slot day (right away if that time has passed).
      await ctx.db.prepare("UPDATE plan_slots SET status = 'READY', content_item_id = ?, note = NULL, updated_at = ? WHERE id = ?").bind(itemId, at, run.slot_id).run();
      return;
    }
    const header = r.rubric === "BREAKING" ? "⚡️ <b>BREAKING-пост готов</b>" : "🔄 <b>Новый вариант поста</b>";
    const weekly = await publishedThisWeek(ctx.db, ctx.now);
    const limit = r.rubric === "BREAKING" && weekly >= 5 ? `\n⚠️ За 7 дней уже ${weekly} постов (максимум 5). Может, заменить им воскресный инсайт?` : "";
    await deliverTextItem(ctx, run.chat_id, itemId, `${header}${limit}`);
  },
};

async function publishedThisWeek(db: D1Database, now: Date): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM content_items WHERE status = 'PUBLISHED' AND published_at >= ?")
    .bind(new Date(now.getTime() - 7 * 86_400_000).toISOString())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** /breaking <link or text>: an important news post outside the schedule. */
export async function requestBreaking(ctx: ContentCtx, chatId: number, adminId: number, input: string): Promise<void> {
  if (!input.trim()) {
    return void (await sendMessage(ctx.tg, chatId, "Пришлите после команды ссылку на новость или пару слов о событии, например:\n<code>/breaking Xitoy O'zbekiston uchun vizasiz rejimni uzaytirdi</code>"));
  }
  const run = await queueRun(ctx.tg, ctx.db, ctx.ai, chatId, adminId, "DRAFT", { rubric: "BREAKING", input: input.trim().slice(0, 1000) }, ctx.now);
  if (run !== null) await sendMessage(ctx.tg, chatId, "⚡️ Проверяю событие по первоисточникам и пишу пост. Если событие не значимое или источника нет, скажу честно.");
}

/** "🔄 Переделать" on a text post: wait for the founder's comment. */
export async function askRegenerate(ctx: ContentCtx, adminId: number, chatId: number, item: ContentRow): Promise<void> {
  await putSetting(ctx.db, REGEN_SETTING(adminId), item.id);
  await sendMessage(ctx.tg, chatId, "🔄 Что исправить? Напишите одним сообщением (например: «короче, больше цифр, другой хук»). Или отправьте «-», чтобы просто сделать другой вариант.");
}

/** The comment for a regeneration. Returns true when the text was consumed. */
export async function handleRegenerateText(ctx: ContentCtx, adminId: number, chatId: number, text: string): Promise<boolean> {
  const itemId = await getSetting<number>(ctx.db, REGEN_SETTING(adminId));
  if (!itemId) return false;
  await ctx.db.prepare("DELETE FROM settings WHERE key = ?").bind(REGEN_SETTING(adminId)).run();
  const item = await getContent(ctx.db, itemId);
  if (!item || item.status !== "PREVIEW" || !item.rubric) return false;
  const comment = text.trim() === "-" ? undefined : text.trim().slice(0, 500);
  const at = ctx.now.toISOString();
  const candidate: TopicCandidate = {
    topic: item.topic ?? "",
    format: item.format ?? "",
    goal: (item.goal as TopicCandidate["goal"]) ?? "TRUST",
    benefit: "",
    hook: "",
    scores: {},
    source_urls: ((item.claims ? JSON.parse(item.claims) : []) as { source_url?: string }[]).map((c) => c.source_url!).filter(Boolean),
  };
  const run = await queueRun(ctx.tg, ctx.db, ctx.ai, chatId, adminId, "DRAFT", { rubric: item.rubric, idea: candidate, comment }, ctx.now, { slotId: item.slot_id });
  if (run === null) return true;
  await ctx.db.prepare("UPDATE content_items SET status = 'REJECTED', reject_reason = ? WHERE id = ?").bind(`переделать${comment ? `: ${comment}` : ""}`, item.id).run();
  if (item.slot_id) await ctx.db.prepare("UPDATE plan_slots SET status = 'RESEARCHING', content_item_id = NULL, updated_at = ? WHERE id = ?").bind(at, item.slot_id).run();
  await logAdminAction(ctx.db, adminId, "post.regenerate", at, { id: item.id, comment });
  await sendMessage(ctx.tg, chatId, "🔄 Переписываю пост, новый вариант придёт через несколько минут.");
  return true;
}
