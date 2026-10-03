// Content System V1: the weekly plan. Every Saturday at 12:00 the bot proposes the next week
// (Mon business model, Wed trust, Fri opportunity, Sun insight) with scored topics; the founder picks and approves.
// Slots then run on their days; nothing reaches the channel without the founder's tap on the post.
import { extractJson, outputText, seenUrls } from "../ai/openai";
import { planPrompt } from "../ai/prompts-content";
import { getSetting, logAdminAction, putSetting } from "../db";
import { addDays, dayLabel, dayShort, daysBetween, nextMonday } from "../content/calendar";
import { FORMATS, RUBRIC_NAMES, RUBRIC_RU, WEEK, rankCandidates, topicKey, type Rubric, type TopicCandidate } from "../content/model";
import { log } from "../log";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { localTime } from "../time";
import { costLine, queueRun, updateRun, type RunHandler } from "./ai";
import { autopilotEnabled } from "./autopilot";
import { startEquipmentSearch } from "./equipment";
import { confirmedExhibitions, seasonHint, updateExhibitionDates, type SimilarExhibition } from "./expo";
import { deliverSlotPost, slotCaseItem, weekQuestions } from "./drafts";
import { rubricPerformance } from "./stats";
import { sendViewsRequest } from "./views";
import type { AiClient } from "../ai/openai";

export const PLAN_CALLBACK_PREFIX = "wk:";
export const MODE_SETTING = "content.mode";
export type ChannelMode = "NORMAL" | "EXHIBITION_SEASON";
const TOPIC_SETTING = (adminId: number) => `await.plan_topic.${adminId}`;
/** Saturday 12:00 local (Abdul, 2026-10-03). */
export const PLAN_WEEKDAY = 6;
export const PLAN_HOUR = 12;
/** Slots start their research at night so the draft is ready by the delivery hour. */
export const SLOT_START_HOUR = 1;
export const SLOT_DELIVERY_HOUR = 9;
/** Reminder about an unconfirmed Monday machine: Sunday 18:00. */
const REMINDER_HOUR = 18;
const RECENT_DAYS = 90;

export interface PlanRow {
  id: number;
  week_start: string;
  status: string;
  mode: ChannelMode;
  chat_id: number;
  message_id: number | null;
  notes: string | null;
}

export interface SlotRow {
  id: number;
  plan_id: number | null;
  slot_date: string;
  rubric: Rubric;
  status: string;
  candidates: string;
  chosen: number | null;
  equipment: string | null;
  equipment_options: string | null;
  content_item_id: number | null;
  research_item_id: number | null;
  note: string | null;
  reminded_at: string | null;
}

interface PlanNotes {
  similar?: SimilarExhibition[];
  dropped?: Partial<Record<Rubric, number>>;
}

export interface ContentCtx {
  db: D1Database;
  tg: Telegram;
  ai: AiClient | null;
  admins: Set<number>;
  now: Date;
  timeZone: string;
}

export const candidatesOf = (slot: SlotRow) => JSON.parse(slot.candidates || "[]") as TopicCandidate[];
export function chosenCandidate(slot: SlotRow): TopicCandidate | null {
  const list = candidatesOf(slot);
  return slot.chosen !== null && slot.chosen !== undefined ? (list[slot.chosen] ?? null) : null;
}

export const getSlot = (db: D1Database, id: number) => db.prepare("SELECT * FROM plan_slots WHERE id = ?").bind(id).first<SlotRow>();
const getPlan = (db: D1Database, id: number) => db.prepare("SELECT * FROM content_plans WHERE id = ?").bind(id).first<PlanRow>();
const slotsOf = async (db: D1Database, planId: number) =>
  (await db.prepare("SELECT * FROM plan_slots WHERE plan_id = ? ORDER BY slot_date").bind(planId).all<SlotRow>()).results;

export async function channelMode(db: D1Database): Promise<ChannelMode> {
  return (await getSetting<ChannelMode>(db, MODE_SETTING)) === "EXHIBITION_SEASON" ? "EXHIBITION_SEASON" : "NORMAL";
}

// ---------- Creating the plan ----------

/** Creates the plan and its four slots and asks the AI for topics. Returns null when it already exists. */
export async function createPlan(ctx: ContentCtx, chatId: number, weekStart: string): Promise<number | null> {
  const at = ctx.now.toISOString();
  const mode = await channelMode(ctx.db);
  const row = await ctx.db
    .prepare("INSERT INTO content_plans (week_start, mode, chat_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (week_start) DO NOTHING RETURNING id")
    .bind(weekStart, mode, chatId, at)
    .first<{ id: number }>();
  if (!row) return null;
  const offset: Record<number, number> = { 1: 0, 3: 2, 5: 4, 0: 6 };
  await ctx.db.batch(
    WEEK.map((w) =>
      ctx.db
        .prepare("INSERT INTO plan_slots (plan_id, slot_date, rubric, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(row.id, addDays(weekStart, offset[w.weekday]!), w.rubric, at, at),
    ),
  );
  const run = await queueRun(ctx.tg, ctx.db, ctx.ai, chatId, 0, "PLAN", { planId: row.id }, ctx.now);
  if (run === null) {
    await ctx.db.prepare("UPDATE content_plans SET status = 'FAILED' WHERE id = ?").bind(row.id).run();
    return row.id;
  }
  await sendMessage(ctx.tg, chatId, `🗓 Готовлю план на неделю с ${dayLabel(weekStart)}: ищу и оцениваю темы. Пришлю через 5–10 минут.`);
  return row.id;
}

async function recentTopics(db: D1Database, now: Date): Promise<{ titles: string[]; keys: string[] }> {
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString();
  const rows = await db
    .prepare(
      `SELECT topic, topic_key FROM content_items WHERE status = 'PUBLISHED' AND published_at >= ? AND topic IS NOT NULL
       UNION ALL SELECT title, NULL FROM research_items WHERE status = 'ACTIVE' AND created_at >= ?`,
    )
    .bind(since, since)
    .all<{ topic: string; topic_key: string | null }>();
  return {
    titles: rows.results.map((r) => r.topic).slice(0, 40),
    keys: rows.results.map((r) => r.topic_key ?? topicKey(r.topic)),
  };
}

export const planHandler: RunHandler = {
  webSearch: true,
  async prompt(db, run, request, now) {
    const plan = await getPlan(db, Number(request.planId));
    const rejected = await db
      .prepare("SELECT topic, reject_reason FROM content_items WHERE reject_reason IS NOT NULL AND created_at >= ? ORDER BY id DESC LIMIT 10")
      .bind(new Date(now.getTime() - 30 * 86_400_000).toISOString())
      .all<{ topic: string | null; reject_reason: string }>();
    return planPrompt({
      today: now.toISOString().slice(0, 10),
      weekStart: plan?.week_start ?? now.toISOString().slice(0, 10),
      mode: plan?.mode ?? "NORMAL",
      exhibitions: await confirmedExhibitions(db),
      recentTopics: (await recentTopics(db, now)).titles,
      rejected: rejected.results.map((r) => `${r.topic ?? "пост"}: ${r.reject_reason}`),
      performance: await rubricPerformance(db, now),
    });
  },
  async finish(ctx, run, res) {
    const request = JSON.parse(run.request) as { planId: number };
    const plan = await getPlan(ctx.db, request.planId);
    if (!plan) return;
    const raw = extractJson(outputText(res)) as {
      slots?: Partial<Record<Rubric, TopicCandidate[]>>;
      exhibition_dates?: unknown[];
      similar_exhibitions?: SimilarExhibition[];
    };
    if (!raw?.slots || typeof raw.slots !== "object") return ["нет объекта slots"];
    const seen = seenUrls(res);
    const { keys } = await recentTopics(ctx.db, ctx.now);
    const expo = (await confirmedExhibitions(ctx.db)).map((e) => e.name.toLowerCase());
    const at = ctx.now.toISOString();
    const notes: PlanNotes = { dropped: {} };
    for (const slot of await slotsOf(ctx.db, plan.id)) {
      if (slot.rubric === "INSIGHT") continue;
      let list = Array.isArray(raw.slots[slot.rubric]) ? raw.slots[slot.rubric]! : [];
      if (slot.rubric === "OPPORTUNITY") {
        // Exhibitions only from the founder's own list (he has to be able to organize the trip).
        list = list.filter(
          (c) => c?.format !== "EXHIBITION" || (typeof c.exhibition === "string" && expo.some((n) => n.includes(c.exhibition!.toLowerCase()) || c.exhibition!.toLowerCase().includes(n))),
        );
      }
      const { kept, dropped } = rankCandidates(list, slot.rubric, seen, keys);
      notes.dropped![slot.rubric] = dropped.length;
      await ctx.db
        .prepare("UPDATE plan_slots SET candidates = ?, chosen = ?, note = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(kept), kept.length ? 0 : null, kept.length ? null : "сильных тем не нашлось", at, slot.id)
        .run();
    }
    await updateExhibitionDates(ctx.db, raw.exhibition_dates, seen, ctx.now);
    notes.similar = (Array.isArray(raw.similar_exhibitions) ? raw.similar_exhibitions : [])
      .filter((s) => s && typeof s.name === "string" && !expo.includes(s.name.toLowerCase()))
      .slice(0, 3);
    await ctx.db.prepare("UPDATE content_plans SET status = 'DRAFT', notes = ? WHERE id = ?").bind(JSON.stringify(notes), plan.id).run();
    await updateRun(ctx.db, run.id, { status: "DONE", result: JSON.stringify({ slots: Object.keys(raw.slots) }) }, ctx.now);
    const fresh = (await getPlan(ctx.db, plan.id))!;
    const view = await renderPlan(ctx.db, fresh, ctx.now);
    const sent = await ctx.tg.call<{ message_id: number }>("sendMessage", {
      chat_id: plan.chat_id,
      text: `${view.text}\n\n${costLine(run)}`.slice(0, 4096),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: view.keyboard },
    });
    await ctx.db.prepare("UPDATE content_plans SET message_id = ? WHERE id = ?").bind(sent?.message_id ?? null, plan.id).run();
  },
};

// ---------- Showing the plan ----------

const STATUS_RU: Record<string, string> = {
  PLANNED: "в плане",
  EQUIPMENT: "ищу станки",
  WAITING_EQUIPMENT: "ждёт выбора станка",
  RESEARCHING: "готовлю",
  READY: "готов, придёт в 9:00",
  DELIVERED: "ждёт публикации",
  PUBLISHED: "опубликован",
  SKIPPED: "пропуск",
  REJECTED: "отклонён",
  FAILED: "не получилось",
};

function candidateLine(c: TopicCandidate, i: number, chosen: boolean): string {
  const mark = chosen ? "✅" : "▫️";
  const score = c.custom ? "своя тема" : `${c.total}`;
  const src = c.source_urls?.[0] ? ` <a href="${escapeHtml(c.source_urls[0])}">источник</a>` : "";
  const flags = c.flags?.length ? ` ⚠️ ${escapeHtml(c.flags.join(", "))}` : "";
  const format = c.format && !c.custom ? ` [${escapeHtml(c.format)}]` : "";
  return `${mark} ${i + 1}. ${escapeHtml(c.topic.slice(0, 120))}${format} · <b>${score}</b>${src}${flags}${c.benefit ? `\n     <i>${escapeHtml(c.benefit.slice(0, 140))}</i>` : ""}`;
}

export async function renderPlan(db: D1Database, plan: PlanRow, now: Date): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const slots = await slotsOf(db, plan.id);
  const notes = (plan.notes ? JSON.parse(plan.notes) : {}) as PlanNotes;
  const parts = [
    `🗓 <b>План на неделю с ${dayLabel(plan.week_start)}</b>${plan.mode === "EXHIBITION_SEASON" ? " · 🎪 сезон выставок" : ""}${plan.status === "APPROVED" ? " · ✅ утверждён" : ""}`,
  ];
  const keyboard: InlineKeyboard = [];
  for (const slot of slots) {
    const head = `<b>${dayShort(slot.slot_date)} · ${RUBRIC_NAMES[slot.rubric]}</b>`;
    if (slot.rubric === "INSIGHT") {
      parts.push(`${head}\nТему выберу в ночь на воскресенье по событиям недели. Если сильной не будет, пропустим.${slot.status === "SKIPPED" ? " (пропуск)" : ""}`);
      continue;
    }
    const list = candidatesOf(slot);
    const lines = list.map((c, i) => candidateLine(c, i, slot.chosen === i && slot.status !== "SKIPPED"));
    const state = slot.status === "SKIPPED" ? "\n⏭ пропускаем" : slot.status !== "PLANNED" ? `\nСтатус: ${STATUS_RU[slot.status] ?? slot.status}` : "";
    parts.push(`${head}\n${lines.join("\n") || `нет тем${slot.note ? `: ${escapeHtml(slot.note)}` : ""}`}${state}`);
    if (slot.status === "PLANNED" || slot.status === "SKIPPED") {
      const day = dayShort(slot.slot_date);
      const row = list.slice(0, 4).map((_, i) => ({ text: `${slot.chosen === i ? "✅" : ""}${day} ${i + 1}`, callback_data: `${PLAN_CALLBACK_PREFIX}c:${slot.id}:${i}` }));
      row.push({ text: "✏️", callback_data: `${PLAN_CALLBACK_PREFIX}t:${slot.id}` });
      row.push({ text: slot.status === "SKIPPED" ? "↩️" : "⏭", callback_data: `${PLAN_CALLBACK_PREFIX}k:${slot.id}` });
      keyboard.push(row);
    }
  }
  const hint = await seasonHint(db, plan.mode, now);
  if (hint) parts.push(hint);
  if (notes.similar?.length) {
    parts.push(
      `<b>Похожие выставки</b> (нет в вашем списке):\n${notes.similar
        .map((s, i) => `${i + 1}. ${escapeHtml(s.name)}${s.city ? `, ${escapeHtml(s.city)}` : ""}${s.why ? ` — ${escapeHtml(s.why)}` : ""}`)
        .join("\n")}`,
    );
    notes.similar.forEach((s, i) => keyboard.push([{ text: `➕ В список: ${s.name}`.slice(0, 60), callback_data: `${PLAN_CALLBACK_PREFIX}x:${plan.id}:${i}` }]));
  }
  if (plan.status !== "APPROVED") {
    parts.push(
      `Цифра = балл темы из 100 (порог 70, для понедельника и выставок 80). Кнопки: выбрать тему, ✏️ своя тема, ⏭ пропустить.\n` +
        `После «Утвердить» начну искать реальные станки для понедельника. Если не утвердить, в дни слотов возьму отмеченные ✅ темы; понедельник без вашего выбора станка не делаю.`,
    );
    keyboard.push([{ text: "✅ Утвердить план", callback_data: `${PLAN_CALLBACK_PREFIX}a:${plan.id}` }]);
  }
  return { text: parts.join("\n\n"), keyboard };
}

async function refreshPlanMessage(ctx: ContentCtx, plan: PlanRow, chatId: number, messageId: number) {
  const view = await renderPlan(ctx.db, plan, ctx.now);
  await ctx.tg
    .call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: view.text.slice(0, 4096),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: view.keyboard },
    })
    .catch((e) => log.error("plan.edit_failed", e));
}

// ---------- Founder's choices ----------

export async function handlePlanCallback(ctx: ContentCtx, callback: { id: string; fromId: number; chatId: number; messageId: number; data: string }) {
  if (await handleWeekButtons(ctx, callback)) return;
  const [action, rawA, rawB] = callback.data.slice(PLAN_CALLBACK_PREFIX.length).split(":");
  const answer = (text?: string) => ctx.tg.call("answerCallbackQuery", { callback_query_id: callback.id, ...(text ? { text } : {}) });
  const at = ctx.now.toISOString();

  if (action === "a" || action === "x") {
    const plan = await getPlan(ctx.db, Number(rawA));
    if (!plan) return void (await answer("План не найден."));
    if (action === "x") {
      const notes = (plan.notes ? JSON.parse(plan.notes) : {}) as PlanNotes;
      const s = notes.similar?.[Number(rawB)];
      if (!s) return void (await answer());
      await ctx.db
        .prepare("INSERT INTO exhibition_calendar (name, city, source_url, status, created_at, updated_at) VALUES (?, ?, ?, 'CONFIRMED', ?, ?)")
        .bind(s.name.slice(0, 120), s.city ?? null, s.source_url ?? null, at, at)
        .run();
      notes.similar = notes.similar!.filter((_, i) => i !== Number(rawB));
      await ctx.db.prepare("UPDATE content_plans SET notes = ? WHERE id = ?").bind(JSON.stringify(notes), plan.id).run();
      await logAdminAction(ctx.db, callback.fromId, "expo.add", at, { name: s.name, via: "plan" });
      await answer(`Добавлено в список: ${s.name}`.slice(0, 190));
      return refreshPlanMessage(ctx, { ...plan, notes: JSON.stringify(notes) }, callback.chatId, callback.messageId);
    }
    if (plan.status === "APPROVED") return void (await answer("Уже утверждён."));
    await ctx.db.prepare("UPDATE content_plans SET status = 'APPROVED', approved_at = ? WHERE id = ?").bind(at, plan.id).run();
    await logAdminAction(ctx.db, callback.fromId, "plan.approve", at, { plan: plan.id });
    await answer("План утверждён.");
    await refreshPlanMessage(ctx, { ...plan, status: "APPROVED" }, callback.chatId, callback.messageId);
    const monday = (await slotsOf(ctx.db, plan.id)).find((s) => s.rubric === "BUSINESS_MODEL" && s.status === "PLANNED" && s.chosen !== null);
    if (monday) await startEquipmentSearch(ctx, monday, callback.chatId);
    return;
  }

  const slot = await getSlot(ctx.db, Number(rawA));
  const plan = slot?.plan_id ? await getPlan(ctx.db, slot.plan_id) : null;
  if (!slot || !plan) return void (await answer("Слот не найден."));
  if (!["PLANNED", "SKIPPED"].includes(slot.status)) return void (await answer("Этот слот уже в работе."));
  if (action === "c") {
    const i = Number(rawB);
    if (!candidatesOf(slot)[i]) return void (await answer());
    await ctx.db.prepare("UPDATE plan_slots SET chosen = ?, status = 'PLANNED', updated_at = ? WHERE id = ?").bind(i, at, slot.id).run();
    await answer();
  } else if (action === "k") {
    const next = slot.status === "SKIPPED" ? "PLANNED" : "SKIPPED";
    await ctx.db.prepare("UPDATE plan_slots SET status = ?, note = ?, updated_at = ? WHERE id = ?").bind(next, next === "SKIPPED" ? "пропуск по решению владельца" : null, at, slot.id).run();
    await answer(next === "SKIPPED" ? "Пропускаем." : "Вернул в план.");
  } else if (action === "t") {
    await putSetting(ctx.db, TOPIC_SETTING(callback.fromId), { slotId: slot.id, chatId: callback.chatId, messageId: callback.messageId });
    await answer();
    await sendMessage(ctx.tg, callback.chatId, `✏️ Напишите свою тему для слота «${dayShort(slot.slot_date)} · ${RUBRIC_NAMES[slot.rubric]}» одним сообщением.`);
    return;
  } else return void (await answer());
  await refreshPlanMessage(ctx, plan, callback.chatId, callback.messageId);
}

/** The founder's own topic for a slot. Returns true when the text was consumed. */
export async function handlePlanTopicText(ctx: ContentCtx, adminId: number, chatId: number, text: string): Promise<boolean> {
  const waiting = await getSetting<{ slotId: number; chatId: number; messageId: number }>(ctx.db, TOPIC_SETTING(adminId));
  if (!waiting) return false;
  await ctx.db.prepare("DELETE FROM settings WHERE key = ?").bind(TOPIC_SETTING(adminId)).run();
  const slot = await getSlot(ctx.db, waiting.slotId);
  const plan = slot?.plan_id ? await getPlan(ctx.db, slot.plan_id) : null;
  if (!slot || !plan || !["PLANNED", "SKIPPED"].includes(slot.status)) return false;
  const list = candidatesOf(slot);
  const topic = text.trim().slice(0, 300);
  list.push({
    topic,
    format: slot.rubric === "TRUST" ? "MASLAHAT" : FORMATS[slot.rubric][0]!,
    goal: slot.rubric === "TRUST" ? "TRUST" : "LEAD_GENERATION",
    benefit: "",
    hook: "",
    scores: {},
    source_urls: [],
    custom: true,
    topic_key: topicKey(topic),
  });
  await ctx.db
    .prepare("UPDATE plan_slots SET candidates = ?, chosen = ?, status = 'PLANNED', updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(list), list.length - 1, ctx.now.toISOString(), slot.id)
    .run();
  await sendMessage(ctx.tg, chatId, `✅ Тема для «${dayShort(slot.slot_date)}» записана: ${escapeHtml(topic)}`);
  await refreshPlanMessage(ctx, plan, waiting.chatId, waiting.messageId);
  return true;
}

// ---------- The cron side ----------

/** Every tick: make the Saturday plan, start today's slots at night, remind about Monday, deliver ready text posts at 09:00. */
export async function runContentPlanner(ctx: ContentCtx): Promise<void> {
  const owner = [...ctx.admins][0];
  if (owner === undefined) return;
  const local = localTime(ctx.now, ctx.timeZone);
  const enabled = await autopilotEnabled(ctx.db);

  if (enabled && ctx.ai && local.weekday === PLAN_WEEKDAY && local.hour >= PLAN_HOUR) {
    const weekStart = addDays(local.date, 2);
    const exists = await ctx.db.prepare("SELECT 1 AS x FROM content_plans WHERE week_start = ?").bind(weekStart).first();
    if (!exists) {
      await createPlan(ctx, owner, weekStart);
      await sendViewsRequest(ctx, owner).catch((e) => log.error("views.request_failed", e));
    }
  }

  // Slots of past days that never started are closed, so the week view stays honest.
  await ctx.db
    .prepare("UPDATE plan_slots SET status = 'SKIPPED', note = 'день прошёл, слот не запускался', updated_at = ? WHERE status = 'PLANNED' AND slot_date < ? AND rubric != 'BUSINESS_MODEL'")
    .bind(ctx.now.toISOString(), local.date)
    .run();

  if (enabled && ctx.ai && local.hour >= SLOT_START_HOUR) {
    const due = await ctx.db
      .prepare("SELECT * FROM plan_slots WHERE status = 'PLANNED' AND slot_date = ? AND rubric IN ('TRUST','OPPORTUNITY','INSIGHT') ORDER BY id")
      .bind(local.date)
      .all<SlotRow>();
    for (const slot of due.results) await startSlot(ctx, slot, owner);
  }

  if (local.weekday === 0 && local.hour >= REMINDER_HOUR) {
    const waiting = await ctx.db
      .prepare("SELECT * FROM plan_slots WHERE rubric = 'BUSINESS_MODEL' AND slot_date = ? AND status IN ('PLANNED','EQUIPMENT','WAITING_EQUIPMENT') AND reminded_at IS NULL")
      .bind(addDays(local.date, 1))
      .all<SlotRow>();
    for (const slot of waiting.results) {
      await ctx.db.prepare("UPDATE plan_slots SET reminded_at = ? WHERE id = ?").bind(ctx.now.toISOString(), slot.id).run();
      const what =
        slot.status === "WAITING_EQUIPMENT"
          ? "выберите станок в карточках выше (или «✏️ Свои данные»)"
          : slot.status === "EQUIPMENT"
            ? "станки ещё ищутся, карточки придут сами"
            : "утвердите план недели, после этого я найду реальные станки";
      await sendMessage(ctx.tg, owner, `⏰ Завтра понедельник «1 STANOK — 1 BIZNES», а станок ещё не подтверждён: ${what}. Без вашего выбора PDF не делаю, пост сдвинется.`);
    }
  }

  if (local.hour >= SLOT_DELIVERY_HOUR) {
    const ready = await ctx.db
      .prepare("SELECT * FROM plan_slots WHERE status = 'READY' AND slot_date <= ? AND content_item_id IS NOT NULL ORDER BY id")
      .bind(local.date)
      .all<SlotRow>();
    for (const slot of ready.results) {
      const claimed = await ctx.db.prepare("UPDATE plan_slots SET status = 'DELIVERED', updated_at = ? WHERE id = ? AND status = 'READY'").bind(ctx.now.toISOString(), slot.id).run();
      if (claimed.meta.changes) await deliverSlotPost(ctx, owner, slot);
    }
  }
}

/** Starts one slot's work. Trust: a ready case first; opportunity: an exhibition goes through the PDF research. */
async function startSlot(ctx: ContentCtx, slot: SlotRow, owner: number): Promise<void> {
  const at = ctx.now.toISOString();
  const claimed = await ctx.db.prepare("UPDATE plan_slots SET status = 'RESEARCHING', updated_at = ? WHERE id = ? AND status = 'PLANNED'").bind(at, slot.id).run();
  if (!claimed.meta.changes) return;
  const skip = (note: string) =>
    ctx.db.prepare("UPDATE plan_slots SET status = 'SKIPPED', note = ?, updated_at = ? WHERE id = ?").bind(note, at, slot.id).run();
  const failed = (note: string) =>
    ctx.db.prepare("UPDATE plan_slots SET status = 'FAILED', note = ?, updated_at = ? WHERE id = ?").bind(note, at, slot.id).run();

  if (slot.rubric === "TRUST" && (await slotCaseItem(ctx, slot))) return;
  const candidate = chosenCandidate(slot) ?? candidatesOf(slot)[0] ?? null;
  if (slot.rubric !== "INSIGHT" && !candidate) return void (await skip("нет темы в плане"));

  let run: number | null;
  if (slot.rubric === "OPPORTUNITY" && candidate!.format === "EXHIBITION") {
    const expo = (await confirmedExhibitions(ctx.db)).find((e) => e.name.toLowerCase() === (candidate!.exhibition ?? "").toLowerCase());
    const query = [candidate!.exhibition ?? candidate!.topic, expo?.city, expo?.starts_on].filter(Boolean).join(", ");
    run = await queueRun(ctx.tg, ctx.db, ctx.ai, owner, 0, "RESEARCH", { query }, ctx.now, { subject: "EXHIBITION", autoDate: slot.slot_date, slotId: slot.id });
  } else {
    const questions = slot.rubric === "INSIGHT" ? await weekQuestions(ctx.db, ctx.now) : undefined;
    run = await queueRun(ctx.tg, ctx.db, ctx.ai, owner, 0, "DRAFT", { rubric: slot.rubric, idea: candidate, questions }, ctx.now, { slotId: slot.id, autoDate: slot.slot_date });
  }
  if (run === null) await failed("AI не запущен: лимит или бюджет");
}

// ---------- Views of the week ----------

/** /week: this week's slots and what each waits on; plus the next week's plan if it exists. */
export async function renderWeek(db: D1Database, now: Date, timeZone: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const today = localTime(now, timeZone).date;
  const plans = await db
    .prepare("SELECT * FROM content_plans WHERE week_start > ? ORDER BY week_start LIMIT 2")
    .bind(addDays(today, -7))
    .all<PlanRow>();
  if (!plans.results.length) {
    return {
      text: `🗓 <b>Эта неделя</b>\n\nПлана пока нет. Он приходит каждую субботу в 12:00, или сейчас: <code>/plan</code>.`,
      keyboard: [[{ text: "🗓 Сделать план сейчас", callback_data: `${PLAN_CALLBACK_PREFIX}n:0` }]],
    };
  }
  const parts: string[] = [];
  const keyboard: InlineKeyboard = [];
  for (const plan of plans.results) {
    const slots = await slotsOf(db, plan.id);
    const current = daysBetween(plan.week_start, today) >= 0;
    parts.push(`🗓 <b>${current ? "Эта неделя" : "Следующая неделя"}</b> (с ${dayLabel(plan.week_start)})${plan.status === "APPROVED" ? " ✅" : plan.status === "FAILED" ? " ⚠️ план не собран" : ""}`);
    for (const slot of slots) {
      const c = chosenCandidate(slot);
      const topic = c ? escapeHtml(c.topic.slice(0, 80)) : slot.rubric === "INSIGHT" ? "по событиям недели" : "—";
      const note = slot.note && ["SKIPPED", "FAILED"].includes(slot.status) ? ` (${escapeHtml(slot.note)})` : "";
      parts.push(`• ${dayShort(slot.slot_date)} · ${RUBRIC_RU[slot.rubric]}: ${topic} · <i>${STATUS_RU[slot.status] ?? slot.status}</i>${note}`);
    }
    if (plan.status !== "APPROVED" && plan.status !== "FAILED") keyboard.push([{ text: `📋 Открыть план с ${dayLabel(plan.week_start)}`, callback_data: `${PLAN_CALLBACK_PREFIX}o:${plan.id}` }]);
  }
  return { text: parts.join("\n"), keyboard };
}

/** /plan: the plan for the coming week now (instead of waiting for Saturday). */
export async function handlePlanCommand(ctx: ContentCtx, chatId: number): Promise<void> {
  const weekStart = nextMonday(localTime(ctx.now, ctx.timeZone).date);
  const existing = await ctx.db.prepare("SELECT * FROM content_plans WHERE week_start = ?").bind(weekStart).first<PlanRow>();
  if (existing && existing.status !== "FAILED") return showPlan(ctx, chatId, existing);
  if (existing) {
    // A plan whose AI run failed is made again from scratch.
    await ctx.db.batch([
      ctx.db.prepare("DELETE FROM plan_slots WHERE plan_id = ?").bind(existing.id),
      ctx.db.prepare("DELETE FROM content_plans WHERE id = ?").bind(existing.id),
    ]);
  }
  await createPlan(ctx, chatId, weekStart);
}

async function showPlan(ctx: ContentCtx, chatId: number, plan: PlanRow) {
  if (plan.status === "PLANNING") return void (await sendMessage(ctx.tg, chatId, "🗓 План ещё готовится, пришлю, как только будет готов."));
  const view = await renderPlan(ctx.db, plan, ctx.now);
  const sent = await ctx.tg.call<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: view.text.slice(0, 4096),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: view.keyboard },
  });
  await ctx.db.prepare("UPDATE content_plans SET message_id = ? WHERE id = ?").bind(sent?.message_id ?? null, plan.id).run();
}

/** Week view buttons: open a plan, or make one now. */
export async function handleWeekButtons(ctx: ContentCtx, callback: { id: string; chatId: number; data: string }): Promise<boolean> {
  const [action, raw] = callback.data.slice(PLAN_CALLBACK_PREFIX.length).split(":");
  if (action !== "o" && action !== "n") return false;
  await ctx.tg.call("answerCallbackQuery", { callback_query_id: callback.id });
  if (action === "n") await handlePlanCommand(ctx, callback.chatId);
  else {
    const plan = await getPlan(ctx.db, Number(raw));
    if (plan) await showPlan(ctx, callback.chatId, plan);
  }
  return true;
}

