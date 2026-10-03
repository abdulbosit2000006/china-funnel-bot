// Autopilot: on planned days the bot researches a topic at night and at 09:00 sends the founder a ready
// PDF + post. One tap publishes both. Nothing reaches the channel or clients without that tap.
import type { AiClient } from "../ai/openai";
import { createFunnelForSlug, createLeadMagnetVersion, getSetting, logAdminAction, nextLeadMagnetVersion, putSetting } from "../db";
import { enqueueJob } from "../jobs";
import { log } from "../log";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import { localTime } from "../time";
import { queueAutopilotRun } from "./ai";
import { createPostDraft } from "./posts";
import type { ResearchRow } from "./research";
import { specByResearchKind, type Subject } from "./subjects";

export const AUTOPILOT_JOB = "AUTOPILOT_DELIVER";
export const AUTOPILOT_ENABLED = "autopilot.enabled";
export const AUTOPILOT_PLAN = "autopilot.plan";
const LAST_START = "autopilot.last_start";
/** Research starts after this local hour so it is ready by the delivery hour. */
const START_HOUR = 1;
export const DELIVERY_HOUR = 9;

/** Weekday (0 = Sunday) → subject. Default: 2 exhibitions and 2 business ideas a week. */
export type Plan = Record<string, Subject>;
export const DEFAULT_PLAN: Plan = { "1": "EXHIBITION", "2": "MANUFACTURING", "4": "EXHIBITION", "5": "MANUFACTURING" };
const DAY_NAMES = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const SUBJECT_NAMES: Record<Subject, string> = { EXHIBITION: "выставка", MANUFACTURING: "бизнес-идея" };

export async function autopilotPlan(db: D1Database): Promise<Plan> {
  return (await getSetting<Plan>(db, AUTOPILOT_PLAN)) ?? DEFAULT_PLAN;
}

export async function autopilotEnabled(db: D1Database): Promise<boolean> {
  return (await getSetting<boolean>(db, AUTOPILOT_ENABLED)) ?? true;
}

interface Ctx {
  db: D1Database;
  tg: Telegram;
  ai: AiClient | null;
  admins: Set<number>;
  now: Date;
  timeZone: string;
}

/** Every cron tick: start today's research at night, hand ready bundles to the job queue from 09:00. */
export async function runAutopilot(ctx: Ctx): Promise<void> {
  const owner = [...ctx.admins][0];
  if (!ctx.ai || owner === undefined) return;
  const local = localTime(ctx.now, ctx.timeZone);
  const at = ctx.now.toISOString();

  if (local.hour >= START_HOUR && (await autopilotEnabled(ctx.db))) {
    const subject = (await autopilotPlan(ctx.db))[String(local.weekday)];
    // One attempt per day, even if it is refused (e.g. the daily AI limit): no retry loop every minute.
    const started = (await getSetting<string>(ctx.db, LAST_START)) === local.date;
    if (subject && !started) {
      await putSetting(ctx.db, LAST_START, local.date);
      const ok = await queueAutopilotRun(ctx.tg, ctx.db, ctx.ai, owner, subject, local.date, ctx.now);
      log.info("autopilot.start", { date: local.date, subject, ok });
    }
  }

  // Deliver what is ready: today's after 09:00, anything older right away (e.g. research that finished late).
  const ready = await ctx.db
    .prepare(
      `SELECT id FROM research_items
        WHERE auto_date IS NOT NULL AND auto_delivered_at IS NULL AND status = 'IN_REVIEW' AND pdf_r2_key IS NOT NULL
          AND (auto_date < ?1 OR (auto_date = ?1 AND ?2 >= ?3))`,
    )
    .bind(local.date, local.hour, DELIVERY_HOUR)
    .all<{ id: number }>();
  for (const row of ready.results) {
    const claimed = await ctx.db.prepare("UPDATE research_items SET auto_delivered_at = ? WHERE id = ? AND auto_delivered_at IS NULL").bind(at, row.id).run();
    if (claimed.meta.changes) await enqueueJob(ctx.db, AUTOPILOT_JOB, { researchId: row.id, chatId: owner }, at);
  }
}

/** Job: send the PDF, make it a draft lead magnet with its campaign link, and draft the post (preview follows). */
export async function runAutopilotDelivery(deps: { tg: Telegram; db: D1Database; files: R2Bucket; now: Date }, payload: { researchId: number; chatId: number }) {
  const { tg, db } = deps;
  const item = await db.prepare("SELECT * FROM research_items WHERE id = ?").bind(payload.researchId).first<ResearchRow & { review_note: string | null; research_date: string }>();
  if (!item || item.status !== "IN_REVIEW" || !item.pdf_r2_key || item.lead_magnet_id) return;
  const spec = specByResearchKind(item.kind);
  const at = deps.now.toISOString();
  const object = await deps.files.get(item.pdf_r2_key);
  if (!object) throw new Error(`PDF missing in R2: ${item.pdf_r2_key}`);

  await sendMessage(
    tg,
    payload.chatId,
    `☀️ <b>Пост на сегодня</b> (${SUBJECT_NAMES[spec.subject]})\n\nНиже PDF и превью поста. Проверьте цифры и источники, затем <b>✅ Опубликовать</b> под постом: PDF включится и пост уйдёт в канал одной кнопкой.`,
  );
  const form = new FormData();
  form.set("chat_id", String(payload.chatId));
  form.set("document", new Blob([await object.arrayBuffer()], { type: "application/pdf" }), `${item.slug}.pdf`);
  form.set("caption", `📄 ${spec.summary(JSON.parse(item.data))}${item.review_note ? `\n\n${item.review_note}` : ""}`.slice(0, 1024));
  form.set("parse_mode", "HTML");
  const sent = await tg.upload<{ document?: { file_id: string } }>("sendDocument", form);
  const fileId = sent.document?.file_id;
  if (!fileId) throw new Error("Telegram returned no file_id for the PDF");

  const magnet = await createLeadMagnetVersion(
    db,
    { slug: item.slug, version: await nextLeadMagnetVersion(db, item.slug), title: item.title, type: spec.magnetType, r2Key: item.pdf_r2_key, tgFileId: fileId },
    at,
  );
  await db.prepare("UPDATE lead_magnets SET research_item_id = ?, research_date = ? WHERE id = ?").bind(item.id, item.research_date ?? null, magnet.id).run();
  await db.prepare("UPDATE research_items SET pdf_tg_file_id = ?, lead_magnet_id = ?, updated_at = ? WHERE id = ?").bind(fileId, magnet.id, at, item.id).run();
  const funnel = await createFunnelForSlug(db, magnet.slug, spec.funnelKind, at);
  await createPostDraft(tg, db, payload.chatId, magnet, funnel, at, { quiet: true });
}

/** /autopilot [on|off|now exhibition|now business]: status, switch, or a run right now (delivered as soon as ready). */
export async function handleAutopilotCommand(ctx: Ctx, chatId: number, adminId: number, arg: string): Promise<void> {
  const at = ctx.now.toISOString();
  const [cmd, what] = arg.toLowerCase().split(/\s+/);
  if (cmd === "on" || cmd === "off") {
    await putSetting(ctx.db, AUTOPILOT_ENABLED, cmd === "on");
    await logAdminAction(ctx.db, adminId, `autopilot.${cmd}`, at);
  } else if (cmd === "now") {
    const subject: Subject = what?.startsWith("b") || what?.startsWith("biz") || what?.startsWith("биз") ? "MANUFACTURING" : "EXHIBITION";
    // Yesterday's slot date makes the bundle deliverable the moment it is ready, and keeps today's slot free.
    const yesterday = localTime(new Date(ctx.now.getTime() - 24 * 3600_000), ctx.timeZone).date;
    if (await queueAutopilotRun(ctx.tg, ctx.db, ctx.ai, chatId, subject, yesterday, ctx.now)) {
      await sendMessage(ctx.tg, chatId, `🤖 Запустил автопилот сейчас: ${SUBJECT_NAMES[subject]}. Готовый PDF и пост придут, как только будут готовы (обычно 10–20 минут).`);
    }
    return;
  }
  const enabled = await autopilotEnabled(ctx.db);
  const plan = await autopilotPlan(ctx.db);
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => plan[String(d)]).map((d) => `${DAY_NAMES[d]}: ${SUBJECT_NAMES[plan[String(d)]!]}`);
  await sendMessage(
    ctx.tg,
    chatId,
    `🤖 <b>Автопилот ${enabled ? "включён" : "выключен"}</b>\n\n` +
      `План: ${escapeHtml(days.join(", ") || "пусто")}\n` +
      `Ночью бот сам выбирает тему и делает research, в ${DELIVERY_HOUR}:00 присылает PDF и пост. Публикация только по вашей кнопке.\n` +
      (ctx.ai ? "" : "\n⚠️ Нет ключа OpenAI, автопилот не работает.\n") +
      `\n<code>/autopilot off</code>, <code>/autopilot on</code>\n<code>/autopilot now exhibition</code> или <code>/autopilot now business</code>: запустить прямо сейчас`,
  );
}
