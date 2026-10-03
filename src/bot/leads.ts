// After the PDF: one follow-up, a short qualification, and cards for the founder.
// Client texts are Uzbek (Latin) and can be overridden in settings (tpl.<name>); admin texts are Russian.
import {
  addScore,
  advanceStage,
  distinctMagnetsReceived,
  getLeadMagnet,
  getSetting,
  logAdminAction,
  recordFunnelEvent,
  setBlocked,
  type LeadMagnetRow,
  type UserRow,
} from "../db";
import { log } from "../log";
import { escapeHtml, sendMessage, TelegramError, type Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { template } from "./templates";

export const FOLLOWUP_CALLBACK_PREFIX = "fu:";
export const QUAL_CALLBACK_PREFIX = "q:";
export const LEAD_CALLBACK_PREFIX = "lc:";
export const FOLLOWUP_DELAY_SETTING = "followup.delay_minutes";
const DEFAULT_FOLLOWUP_MINUTES = 150;
/** Never more than one follow-up per person per day, whatever the number of PDFs. */
const FOLLOWUP_GAP_HOURS = 24;
const QUESTION_STATE = "QUESTION";

export interface LeadContext {
  db: D1Database;
  tg: Telegram;
  admins: Set<number>;
  now: Date;
}

// ---------- Qualification questions (button answers only: no forms to type) ----------

interface Question {
  key: string;
  text: string;
  options: string[];
}

const EXHIBITION_QUESTIONS: Question[] = [
  { key: "travelers", text: "Necha kishi borishni rejalashtiryapsiz?", options: ["1 kishi", "2 kishi", "3–5 kishi", "5+ kishi"] },
  { key: "when", text: "Qachon borishni o'ylayapsiz?", options: ["Shu ko'rgazmaga", "Keyingi safar", "Hali aniq emas"] },
  { key: "help", text: "Safarni tashkil qilishda yordam kerakmi?", options: ["Ha, to'liq hamrohlik", "Faqat ko'rgazmada", "Maslahat yetarli"] },
];

const MANUFACTURING_QUESTIONS: Question[] = [
  { key: "budget", text: "Taxminiy byudjetingiz qancha?", options: ["$20 000 gacha", "$20–50 ming", "$50–150 ming", "$150 000+", "Aytmayman"] },
  { key: "location", text: "Ishlab chiqarish qayerda bo'ladi?", options: ["Toshkent", "Viloyatda", "Hali aniq emas"] },
  { key: "timeline", text: "Qachon boshlamoqchisiz?", options: ["3 oy ichida", "6–12 oy", "Hozircha o'rganyapman"] },
  { key: "sourcing", text: "Uskunani topish va tekshirishda yordam kerakmi?", options: ["Ha", "Yo'q, faqat maslahat"] },
];

const GENERAL_QUESTIONS: Question[] = [
  { key: "timeline", text: "Qachon boshlamoqchisiz?", options: ["3 oy ichida", "6–12 oy", "Hozircha o'rganyapman"] },
  { key: "help", text: "Qanday yordam kerak?", options: ["Uskuna / xomashyo topish", "Xitoyga safar", "Maslahat"] },
];

function questionsFor(magnet: LeadMagnetRow): Question[] {
  if (magnet.type === "EXHIBITION_GUIDE") return EXHIBITION_QUESTIONS;
  if (magnet.type === "MANUFACTURING_MODEL") return MANUFACTURING_QUESTIONS;
  return GENERAL_QUESTIONS;
}

function personLink(user: { tg_user_id: number; first_name: string | null; username: string | null }): string {
  const name = escapeHtml(user.first_name ?? "Без имени");
  return user.username ? `${name} (@${escapeHtml(user.username)})` : `<a href="tg://user?id=${user.tg_user_id}">${name}</a>`;
}

const chatUrl = (user: { tg_user_id: number; username: string | null }) =>
  user.username ? `https://t.me/${user.username}` : `tg://user?id=${user.tg_user_id}`;

async function notifyAdmins(ctx: LeadContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  for (const adminId of ctx.admins) {
    try {
      await sendMessage(ctx.tg, adminId, text, keyboard);
    } catch (error) {
      log.error("admin.notify_failed", error, { admin: adminId });
    }
  }
}

async function pdfHistory(db: D1Database, userId: number): Promise<string> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT lm.title FROM funnel_events fe JOIN lead_magnets lm ON lm.id = fe.lead_magnet_id
        WHERE fe.user_id = ? AND fe.type = 'PDF_SENT' ORDER BY fe.id`,
    )
    .bind(userId)
    .all<{ title: string }>();
  return rows.results.map((r) => escapeHtml(r.title)).join("; ") || "—";
}

async function campaignCode(db: D1Database, funnelId: number | null): Promise<string> {
  if (!funnelId) return "—";
  const row = await db.prepare("SELECT code FROM funnels WHERE id = ?").bind(funnelId).first<{ code: string }>();
  return row?.code ?? "—";
}

// ---------- After a PDF ----------

/** Called right after a PDF was delivered: schedules the single follow-up and checks the engagement signal. */
export async function afterPdfDelivered(ctx: LeadContext, user: UserRow, magnet: LeadMagnetRow, funnelId: number | null): Promise<void> {
  const minutes = (await getSetting<number>(ctx.db, FOLLOWUP_DELAY_SETTING)) ?? DEFAULT_FOLLOWUP_MINUTES;
  const due = new Date(ctx.now.getTime() + minutes * 60_000).toISOString();
  await ctx.db
    .prepare("INSERT INTO followups (user_id, lead_magnet_id, funnel_id, due_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(user.id, magnet.id, funnelId, due)
    .run();
  await checkHotSignal(ctx, user, funnelId);
}

/** Several PDFs (or PDFs plus interest) from one person: tell the founder once. It is a signal, not a promise to buy. */
async function checkHotSignal(ctx: LeadContext, user: UserRow, funnelId: number | null): Promise<void> {
  const lead = await ctx.db.prepare("SELECT stage, hot_signal_at FROM leads WHERE user_id = ?").bind(user.id).first<{ stage: string; hot_signal_at: string | null }>();
  if (!lead || lead.hot_signal_at) return;
  const pdfs = await distinctMagnetsReceived(ctx.db, user.id);
  const interested = ["INTERESTED", "QUALIFIED", "CONTACTED"].includes(lead.stage);
  if (pdfs < 3 && !(pdfs >= 2 && interested)) return;
  const now = ctx.now.toISOString();
  const claimed = await ctx.db.prepare("UPDATE leads SET hot_signal_at = ? WHERE user_id = ? AND hot_signal_at IS NULL").bind(now, user.id).run();
  if (!claimed.meta.changes) return;
  await recordFunnelEvent(ctx.db, { userId: user.id, type: "HOT_SIGNAL", funnelId, payload: { pdfs, interested } }, now);
  await notifyAdmins(
    ctx,
    `🌡 <b>Сигнал вовлечённости</b> (не гарантия покупки)\n\n` +
      `Кто: ${personLink(user)}\nВзял PDF: ${pdfs}${interested ? ", нажимал «интересно»" : ""}\nВсе PDF: ${await pdfHistory(ctx.db, user.id)}`,
    [[{ text: "💬 Открыть чат", url: chatUrl(user) }]],
  );
}

// ---------- Follow-up (cron) ----------

interface DueFollowup {
  id: number;
  user_id: number;
  lead_magnet_id: number;
  funnel_id: number | null;
  tg_user_id: number;
  opted_out: number;
  is_blocked_bot: number;
}

/** Sends the follow-ups that are due. Skips people who already answered, opted out, blocked the bot or got one today. */
export async function runFollowups(ctx: Omit<LeadContext, "admins">, limit = 20): Promise<number> {
  const now = ctx.now.toISOString();
  const due = await ctx.db
    .prepare(
      `SELECT f.id, f.user_id, f.lead_magnet_id, f.funnel_id, u.tg_user_id, u.opted_out, u.is_blocked_bot
         FROM followups f JOIN users u ON u.id = f.user_id
        WHERE f.status = 'PENDING' AND f.due_at <= ? ORDER BY f.due_at LIMIT ?`,
    )
    .bind(now, limit)
    .all<DueFollowup>();
  let sent = 0;
  for (const f of due.results) {
    const claimed = await ctx.db.prepare("UPDATE followups SET status = 'SENDING' WHERE id = ? AND status = 'PENDING'").bind(f.id).run();
    if (!claimed.meta.changes) continue;
    const cancel = (reason: string) =>
      ctx.db.prepare("UPDATE followups SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?").bind(reason, f.id).run();
    if (f.opted_out) { await cancel("opted_out"); continue; }
    if (f.is_blocked_bot) { await cancel("blocked"); continue; }
    const answered = await ctx.db
      .prepare(
        `SELECT 1 AS x FROM funnel_events WHERE user_id = ? AND lead_magnet_id = ?
           AND type IN ('CTA_CLICK','INTERESTED','QUESTION','NOT_NOW','QUALIFIED') LIMIT 1`,
      )
      .bind(f.user_id, f.lead_magnet_id)
      .first();
    if (answered) { await cancel("already_engaged"); continue; }
    const since = new Date(ctx.now.getTime() - FOLLOWUP_GAP_HOURS * 3600_000).toISOString();
    const recent = await ctx.db.prepare("SELECT 1 AS x FROM followups WHERE user_id = ? AND status = 'SENT' AND sent_at >= ? LIMIT 1").bind(f.user_id, since).first();
    if (recent) { await cancel("recent_followup"); continue; }
    try {
      await sendMessage(ctx.tg, f.tg_user_id, await template(ctx.db, "followup"), [
        [
          { text: await template(ctx.db, "followupYes"), callback_data: `${FOLLOWUP_CALLBACK_PREFIX}i:${f.id}` },
          { text: await template(ctx.db, "followupQuestion"), callback_data: `${FOLLOWUP_CALLBACK_PREFIX}q:${f.id}` },
        ],
        [{ text: await template(ctx.db, "followupNo"), callback_data: `${FOLLOWUP_CALLBACK_PREFIX}n:${f.id}` }],
      ]);
    } catch (error) {
      const blocked = error instanceof TelegramError && error.code === 403;
      await ctx.db.prepare("UPDATE followups SET status = 'FAILED', cancel_reason = ? WHERE id = ?").bind(blocked ? "blocked" : String(error).slice(0, 200), f.id).run();
      if (blocked) await setBlocked(ctx.db, f.tg_user_id, true);
      else log.error("followup.failed", error, { id: f.id });
      continue;
    }
    await ctx.db.prepare("UPDATE followups SET status = 'SENT', sent_at = ? WHERE id = ?").bind(now, f.id).run();
    await recordFunnelEvent(ctx.db, { userId: f.user_id, type: "FOLLOWUP_SENT", funnelId: f.funnel_id, leadMagnetId: f.lead_magnet_id }, now);
    sent++;
  }
  return sent;
}

// ---------- Client answers ----------

/** "Qiziqaman" from the follow-up or "Muhokama qilmoqchiman" after the PDF: interest, then the questions. */
export async function startInterest(ctx: LeadContext, chatId: number, user: UserRow, magnet: LeadMagnetRow, funnelId: number | null, via: "cta" | "followup") {
  const now = ctx.now.toISOString();
  const already = await ctx.db
    .prepare("SELECT 1 AS x FROM funnel_events WHERE user_id = ? AND lead_magnet_id = ? AND type = 'INTERESTED' LIMIT 1")
    .bind(user.id, magnet.id)
    .first();
  if (already) return void (await sendMessage(ctx.tg, chatId, await template(ctx.db, "ctaAlready")));
  if (via === "cta") await recordFunnelEvent(ctx.db, { userId: user.id, type: "CTA_CLICK", funnelId, leadMagnetId: magnet.id }, now);
  else await recordFunnelEvent(ctx.db, { userId: user.id, type: "FOLLOWUP_REPLY", funnelId, leadMagnetId: magnet.id, payload: { answer: "interested" } }, now);
  await recordFunnelEvent(ctx.db, { userId: user.id, type: "INTERESTED", funnelId, leadMagnetId: magnet.id, payload: { via } }, now);
  await advanceStage(ctx.db, user.id, "INTERESTED", now);
  await addScore(ctx.db, user.id, 3, now);

  await notifyAdmins(
    ctx,
    `🟡 <b>Клиент заинтересовался</b> (сейчас отвечает на 2–4 вопроса)\n\n` +
      `Кто: ${personLink(user)}\nМатериал: ${escapeHtml(magnet.title)} (v${magnet.version})\n` +
      `Кампания: <code>${escapeHtml(await campaignCode(ctx.db, funnelId))}</code>`,
    [[{ text: "💬 Открыть чат", url: chatUrl(user) }]],
  );
  await sendMessage(ctx.tg, chatId, await template(ctx.db, "qualIntro"));
  await askQuestion(ctx, chatId, magnet, funnelId, 0);
  await checkHotSignal(ctx, user, funnelId);
}

async function askQuestion(ctx: LeadContext, chatId: number, magnet: LeadMagnetRow, funnelId: number | null, step: number) {
  const q = questionsFor(magnet)[step]!;
  const keyboard: InlineKeyboard = q.options.map((option, i) => [
    { text: option, callback_data: `${QUAL_CALLBACK_PREFIX}${magnet.id}:${funnelId ?? 0}:${step}:${i}` },
  ]);
  await sendMessage(ctx.tg, chatId, `${step + 1}/${questionsFor(magnet).length}. ${q.text}`, keyboard);
}

/** A qualification button: store the answer, ask the next question or hand the lead to the founder. */
export async function handleQualAnswer(ctx: LeadContext, callback: { id: string; chatId: number; messageId: number; data: string }, user: UserRow) {
  const [rawMagnet, rawFunnel, rawStep, rawOption] = callback.data.slice(QUAL_CALLBACK_PREFIX.length).split(":");
  await ctx.tg.call("answerCallbackQuery", { callback_query_id: callback.id });
  const magnet = await getLeadMagnet(ctx.db, Number(rawMagnet));
  if (!magnet) return;
  const questions = questionsFor(magnet);
  const step = Number(rawStep);
  const q = questions[step];
  const answer = q?.options[Number(rawOption)];
  if (!q || answer === undefined) return;
  const funnelId = Number(rawFunnel) || null;
  const now = ctx.now.toISOString();

  const lead = await ctx.db.prepare("SELECT answers FROM leads WHERE user_id = ?").bind(user.id).first<{ answers: string | null }>();
  const all = (lead?.answers ? JSON.parse(lead.answers) : {}) as Record<string, Record<string, string>>;
  const mine = (all[magnet.slug] ??= {});
  if (mine[q.key] !== undefined) return; // double tap
  mine[q.key] = answer;
  await ctx.db.prepare("UPDATE leads SET answers = ?, updated_at = ? WHERE user_id = ?").bind(JSON.stringify(all), now, user.id).run();
  await recordFunnelEvent(ctx.db, { userId: user.id, type: "QUAL_ANSWER", funnelId, leadMagnetId: magnet.id, payload: { [q.key]: answer } }, now);
  // Show the chosen answer instead of the buttons.
  await ctx.tg
    .call("editMessageText", { chat_id: callback.chatId, message_id: callback.messageId, text: `${step + 1}/${questions.length}. ${q.text}\n✔️ ${answer}` })
    .catch(() => undefined);

  if (step + 1 < questions.length) return askQuestion(ctx, callback.chatId, magnet, funnelId, step + 1);

  await recordFunnelEvent(ctx.db, { userId: user.id, type: "QUALIFIED", funnelId, leadMagnetId: magnet.id, payload: mine }, now);
  await advanceStage(ctx.db, user.id, "QUALIFIED", now);
  await addScore(ctx.db, user.id, 5, now);
  await ctx.db.prepare("UPDATE leads SET notified_admin_at = ? WHERE user_id = ?").bind(now, user.id).run();
  await sendMessage(ctx.tg, callback.chatId, await template(ctx.db, "qualDone"));

  const first = await ctx.db.prepare("SELECT first_source FROM users WHERE id = ?").bind(user.id).first<{ first_source: string | null }>();
  const answers = questions.map((qq) => `• ${escapeHtml(qq.text)} <b>${escapeHtml(mine[qq.key] ?? "—")}</b>`).join("\n");
  await notifyAdmins(
    ctx,
    `🔥 <b>QUALIFIED LEAD</b>\n\n` +
      `Кто: ${personLink(user)}\n` +
      `Материал: ${escapeHtml(magnet.title)} (v${magnet.version})\n` +
      `Кампания: <code>${escapeHtml(await campaignCode(ctx.db, funnelId))}</code>\n` +
      `Первый источник: <code>${escapeHtml(first?.first_source ?? "—")}</code>\n` +
      `Все PDF: ${await pdfHistory(ctx.db, user.id)}\n\n<b>Ответы</b>\n${answers}\n\n` +
      `Время: ${now.slice(0, 16).replace("T", " ")} UTC`,
    [
      [{ text: "💬 Открыть чат", url: chatUrl(user) }],
      [
        { text: "✅ Связался", callback_data: `${LEAD_CALLBACK_PREFIX}c:${user.id}` },
        { text: "🚫 Не целевой", callback_data: `${LEAD_CALLBACK_PREFIX}n:${user.id}` },
      ],
    ],
  );
}

/** Follow-up buttons: interested / question / not now. */
export async function handleFollowupAnswer(ctx: LeadContext, callback: { id: string; chatId: number; messageId: number; data: string }, user: UserRow) {
  const [action, rawId] = callback.data.slice(FOLLOWUP_CALLBACK_PREFIX.length).split(":");
  const f = await ctx.db
    .prepare("SELECT id, user_id, lead_magnet_id, funnel_id FROM followups WHERE id = ?")
    .bind(Number(rawId))
    .first<{ id: number; user_id: number; lead_magnet_id: number; funnel_id: number | null }>();
  await ctx.tg.call("answerCallbackQuery", { callback_query_id: callback.id });
  if (!f || f.user_id !== user.id) return;
  const magnet = await getLeadMagnet(ctx.db, f.lead_magnet_id);
  if (!magnet) return;
  await ctx.tg.call("editMessageReplyMarkup", { chat_id: callback.chatId, message_id: callback.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  const now = ctx.now.toISOString();
  if (action === "i") return startInterest(ctx, callback.chatId, user, magnet, f.funnel_id, "followup");
  if (action === "n") {
    await recordFunnelEvent(ctx.db, { userId: user.id, type: "NOT_NOW", funnelId: f.funnel_id, leadMagnetId: magnet.id }, now);
    return void (await sendMessage(ctx.tg, callback.chatId, await template(ctx.db, "followupNoReply")));
  }
  if (action === "q") {
    await recordFunnelEvent(ctx.db, { userId: user.id, type: "QUESTION", funnelId: f.funnel_id, leadMagnetId: magnet.id }, now);
    await ctx.db
      .prepare("UPDATE users SET state = ?, state_data = ? WHERE id = ?")
      .bind(QUESTION_STATE, JSON.stringify({ magnetId: magnet.id, funnelId: f.funnel_id }), user.id)
      .run();
    await sendMessage(ctx.tg, callback.chatId, await template(ctx.db, "questionAsk"));
  }
}

/** A text post's campaign link (no PDF behind it): the reader came to ask something. */
export async function startQuestionFromPost(ctx: LeadContext, chatId: number, user: UserRow, funnelId: number): Promise<void> {
  await ctx.db.prepare("UPDATE users SET state = ?, state_data = ? WHERE id = ?").bind(QUESTION_STATE, JSON.stringify({ funnelId }), user.id).run();
  await sendMessage(ctx.tg, chatId, await template(ctx.db, "questionStart"));
}

/** A client's free text while we wait for their question: forward it to the founder. Returns true when consumed. */
export async function handleClientText(ctx: LeadContext, chatId: number, user: UserRow, text: string): Promise<boolean> {
  const row = await ctx.db.prepare("SELECT state, state_data FROM users WHERE id = ?").bind(user.id).first<{ state: string | null; state_data: string | null }>();
  if (row?.state !== QUESTION_STATE) return false;
  await ctx.db.prepare("UPDATE users SET state = NULL, state_data = NULL WHERE id = ?").bind(user.id).run();
  const data = JSON.parse(row.state_data ?? "{}") as { magnetId?: number; funnelId?: number | null };
  const magnet = data.magnetId ? await getLeadMagnet(ctx.db, data.magnetId) : null;
  await recordFunnelEvent(ctx.db, { userId: user.id, type: "FOLLOWUP_REPLY", funnelId: data.funnelId ?? null, leadMagnetId: magnet?.id ?? null, payload: { answer: "question", text: text.slice(0, 500) } }, ctx.now.toISOString());
  await advanceStage(ctx.db, user.id, "ENGAGED", ctx.now.toISOString());
  await notifyAdmins(
    ctx,
    `❓ <b>Вопрос от клиента</b>\n\nКто: ${personLink(user)}\nМатериал: ${escapeHtml(magnet?.title ?? "—")}\n\n«${escapeHtml(text.slice(0, 1500))}»`,
    [[{ text: "💬 Ответить в чате", url: chatUrl(user) }]],
  );
  await sendMessage(ctx.tg, chatId, await template(ctx.db, "questionThanks"));
  return true;
}

// ---------- Founder actions on a lead card ----------

export async function handleLeadAction(
  ctx: LeadContext,
  callback: { id: string; fromId: number; chatId: number; messageId: number; data: string },
): Promise<void> {
  const [action, rawUser] = callback.data.slice(LEAD_CALLBACK_PREFIX.length).split(":");
  const userId = Number(rawUser);
  const now = ctx.now.toISOString();
  const answer = (text: string) => ctx.tg.call("answerCallbackQuery", { callback_query_id: callback.id, text });
  if (action === "c") {
    await ctx.db.prepare("UPDATE leads SET stage = 'CONTACTED', contacted_at = ?, updated_at = ? WHERE user_id = ? AND stage != 'NOT_QUALIFIED'").bind(now, now, userId).run();
    await recordFunnelEvent(ctx.db, { userId, type: "CONTACTED", payload: { by: callback.fromId } }, now);
    await logAdminAction(ctx.db, callback.fromId, "lead.contacted", now, { user: userId });
    await answer("Отмечено: связались.");
  } else if (action === "n") {
    await ctx.db.prepare("UPDATE leads SET stage = 'NOT_QUALIFIED', updated_at = ? WHERE user_id = ?").bind(now, userId).run();
    await recordFunnelEvent(ctx.db, { userId, type: "NOT_QUALIFIED", payload: { by: callback.fromId } }, now);
    await logAdminAction(ctx.db, callback.fromId, "lead.not_qualified", now, { user: userId });
    await answer("Отмечено: не целевой.");
  } else return void (await answer(""));
  await ctx.tg
    .call("editMessageReplyMarkup", { chat_id: callback.chatId, message_id: callback.messageId, reply_markup: { inline_keyboard: [] } })
    .catch(() => undefined);
}

