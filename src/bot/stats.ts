// Statistics, the leads list and the morning report for the founder (Russian).
import { getSetting, putSetting } from "../db";
import { RUBRIC_RU, type Rubric } from "../content/model";
import { aiSpend } from "./budget";
import { log } from "../log";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import { localTime } from "../time";

export const REPORT_SETTING = "report.last_date";
export const REPORT_HOUR = 9;

const TYPE_NAMES: Record<string, string> = {
  EXHIBITION_GUIDE: "Выставки",
  MANUFACTURING_MODEL: "Бизнес-модели",
  MACHINERY_GUIDE: "Оборудование",
  RAW_MATERIAL_GUIDE: "Сырьё",
};

const STAGE_NAMES: Record<string, string> = {
  VISITOR: "посетитель",
  LEAD: "взял PDF",
  ENGAGED: "вовлечён",
  INTERESTED: "интерес",
  QUALIFIED: "квалифицирован",
  CONTACTED: "связались",
  NOT_QUALIFIED: "не целевой",
};

export interface PeriodStats {
  starts: number;
  uniqueUsers: number;
  newUsers: number;
  pdfs: number;
  followups: number;
  followupReplies: number;
  interested: number;
  qualified: number;
  contacted: number;
}

export async function periodStats(db: D1Database, since: string): Promise<PeriodStats> {
  const count = (type: string) =>
    db.prepare("SELECT COUNT(*) AS n FROM funnel_events WHERE type = ? AND created_at >= ?").bind(type, since);
  const rows = await db.batch<{ n: number }>([
    count("START"),
    db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM funnel_events WHERE created_at >= ?").bind(since),
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?").bind(since),
    count("PDF_SENT"),
    count("FOLLOWUP_SENT"),
    db.prepare("SELECT COUNT(*) AS n FROM funnel_events WHERE type IN ('FOLLOWUP_REPLY','NOT_NOW','QUESTION') AND created_at >= ?").bind(since),
    count("INTERESTED"),
    count("QUALIFIED"),
    count("CONTACTED"),
  ]);
  const n = (i: number) => rows[i]?.results[0]?.n ?? 0;
  return {
    starts: n(0),
    uniqueUsers: n(1),
    newUsers: n(2),
    pdfs: n(3),
    followups: n(4),
    followupReplies: n(5),
    interested: n(6),
    qualified: n(7),
    contacted: n(8),
  };
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

function funnelLines(s: PeriodStats): string {
  return (
    `Входы в бота: <b>${s.starts}</b> (уникальных людей ${s.uniqueUsers}, новых ${s.newUsers})\n` +
    `PDF выдано: <b>${s.pdfs}</b>\n` +
    `Follow-up: отправлено ${s.followups}, ответили ${s.followupReplies} (${pct(s.followupReplies, s.followups)})\n` +
    `Интерес: <b>${s.interested}</b> · квалифицированы: <b>${s.qualified}</b> · связались: ${s.contacted}\n` +
    `Конверсия вход → интерес: ${pct(s.interested, s.starts)}, → квалифицирован: ${pct(s.qualified, s.starts)}`
  );
}

interface CampaignRow {
  code: string;
  title: string | null;
  starts: number;
  pdfs: number;
  interested: number;
  qualified: number;
}

/** Which posts (campaign links) bring people, and which bring leads. */
export async function topCampaigns(db: D1Database, since: string, limit = 5): Promise<CampaignRow[]> {
  const rows = await db
    .prepare(
      `SELECT f.code, (SELECT title FROM lead_magnets WHERE slug = f.lead_magnet_slug ORDER BY version DESC LIMIT 1) AS title,
              SUM(fe.type = 'START') AS starts, SUM(fe.type = 'PDF_SENT') AS pdfs,
              SUM(fe.type = 'INTERESTED') AS interested, SUM(fe.type = 'QUALIFIED') AS qualified
         FROM funnel_events fe JOIN funnels f ON f.id = fe.funnel_id
        WHERE fe.created_at >= ?
        GROUP BY f.id ORDER BY qualified DESC, interested DESC, starts DESC LIMIT ?`,
    )
    .bind(since, limit)
    .all<CampaignRow>();
  return rows.results;
}

interface TopicRow {
  type: string;
  pdfs: number;
  interested: number;
  qualified: number;
}

/** Leads by topic: the question "which topic brings the strongest leads", not which gets the most clicks. */
export async function topicStats(db: D1Database, since: string): Promise<TopicRow[]> {
  const rows = await db
    .prepare(
      `SELECT lm.type, SUM(fe.type = 'PDF_SENT') AS pdfs, SUM(fe.type = 'INTERESTED') AS interested, SUM(fe.type = 'QUALIFIED') AS qualified
         FROM funnel_events fe JOIN lead_magnets lm ON lm.id = fe.lead_magnet_id
        WHERE fe.created_at >= ? GROUP BY lm.type ORDER BY qualified DESC, interested DESC`,
    )
    .bind(since)
    .all<TopicRow>();
  return rows.results;
}

function campaignLines(rows: CampaignRow[]): string {
  if (!rows.length) return "пока нет данных";
  return rows
    .map((r, i) => `${i + 1}. ${escapeHtml(r.title ?? r.code)}: входы ${r.starts}, PDF ${r.pdfs}, интерес ${r.interested}, квал. ${r.qualified}`)
    .join("\n");
}

function topicLines(rows: TopicRow[]): string {
  if (!rows.length) return "пока нет данных";
  return rows
    .map((r) => `• ${TYPE_NAMES[r.type] ?? r.type}: PDF ${r.pdfs}, интерес ${r.interested} (${pct(r.interested, r.pdfs)}), квал. ${r.qualified}`)
    .join("\n");
}

export interface RubricRow {
  rubric: Rubric;
  posts: number;
  views: number;
  withViews: number;
  starts: number;
  pdfs: number;
  interested: number;
  qualified: number;
}

/** Posts, views and what their links brought, per rubric, for posts published in [since, until). */
export async function rubricStats(db: D1Database, since: string, until = "9999"): Promise<RubricRow[]> {
  const [posts, funnel] = await db.batch<Record<string, number | string>>([
    db
      .prepare(
        `SELECT rubric, COUNT(*) AS posts, SUM(COALESCE(views, 0)) AS views, SUM(views IS NOT NULL) AS with_views
           FROM content_items WHERE status = 'PUBLISHED' AND rubric IS NOT NULL AND published_at >= ? AND published_at < ? GROUP BY rubric`,
      )
      .bind(since, until),
    db
      .prepare(
        `SELECT ci.rubric, SUM(fe.type = 'START') AS starts, SUM(fe.type = 'PDF_SENT') AS pdfs,
                SUM(fe.type = 'INTERESTED') AS interested, SUM(fe.type = 'QUALIFIED') AS qualified
           FROM funnel_events fe JOIN funnels f ON f.id = fe.funnel_id JOIN content_items ci ON ci.id = f.content_item_id
          WHERE ci.status = 'PUBLISHED' AND ci.rubric IS NOT NULL AND ci.published_at >= ? AND ci.published_at < ? GROUP BY ci.rubric`,
      )
      .bind(since, until),
  ]);
  const byRubric = new Map((funnel?.results ?? []).map((r) => [r.rubric as string, r]));
  return (posts?.results ?? []).map((p) => {
    const f = byRubric.get(p.rubric as string) ?? {};
    const n = (x: unknown) => Number(x ?? 0);
    return {
      rubric: p.rubric as Rubric,
      posts: n(p.posts),
      views: n(p.views),
      withViews: n(p.with_views),
      starts: n(f.starts),
      pdfs: n(f.pdfs),
      interested: n(f.interested),
      qualified: n(f.qualified),
    };
  });
}

function rubricLines(rows: RubricRow[]): string {
  if (!rows.length) return "пока нет опубликованных постов";
  return rows
    .map((r) => {
      const views = r.withViews ? `, просмотры ${r.views}` : "";
      const conv = r.withViews && r.views ? `, вход/просмотр ${pct(r.starts, r.views)}` : "";
      return `• ${RUBRIC_RU[r.rubric] ?? r.rubric}: постов ${r.posts}${views}, входы ${r.starts}, PDF ${r.pdfs}, интерес ${r.interested}, квал. ${r.qualified}${conv}`;
    })
    .join("\n");
}

/** Short lines for the weekly plan prompt: what brought leads in the last 30 days. */
export async function rubricPerformance(db: D1Database, now: Date): Promise<string[]> {
  const rows = await rubricStats(db, daysAgo(now, 30));
  const best = await db
    .prepare(
      `SELECT ci.topic, ci.rubric, SUM(fe.type = 'INTERESTED') + SUM(fe.type = 'QUALIFIED') * 2 AS score, SUM(fe.type = 'START') AS starts
         FROM content_items ci JOIN funnels f ON f.content_item_id = ci.id LEFT JOIN funnel_events fe ON fe.funnel_id = f.id
        WHERE ci.status = 'PUBLISHED' AND ci.published_at >= ? GROUP BY ci.id ORDER BY score DESC, starts DESC LIMIT 3`,
    )
    .bind(daysAgo(now, 30))
    .all<{ topic: string | null; rubric: string; score: number; starts: number }>();
  return [
    ...rows.map((r) => `${r.rubric}: постов ${r.posts}, входы в бота ${r.starts}, интерес ${r.interested}, квалифицированы ${r.qualified}${r.withViews ? `, просмотры ${r.views}` : ""}`),
    ...best.results.filter((b) => b.starts > 0).map((b) => `лучший пост: «${b.topic ?? ""}» (${b.rubric}), входы ${b.starts}`),
  ];
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 24 * 3600_000).toISOString();

export async function renderStatistics(db: D1Database, now: Date): Promise<string> {
  const [week, month] = await Promise.all([periodStats(db, daysAgo(now, 7)), periodStats(db, daysAgo(now, 30))]);
  return (
    `<b>📈 Статистика</b>\n\n<b>7 дней</b>\n${funnelLines(week)}\n\n<b>30 дней</b>\n${funnelLines(month)}\n\n` +
    `<b>Лучшие посты за 30 дней</b> (по лидам)\n${campaignLines(await topCampaigns(db, daysAgo(now, 30)))}\n\n` +
    `<b>Темы за 30 дней</b>\n${topicLines(await topicStats(db, daysAgo(now, 30)))}\n\n` +
    `<b>Рубрики за 30 дней</b>\n${rubricLines(await rubricStats(db, daysAgo(now, 30)))}\n\n` +
    `<i>Просмотры Telegram боту не отдаёт: их вводите вы раз в неделю (<code>/views</code>). Остальное считаем от входа в бота.</i>`
  );
}

interface LeadRow {
  stage: string;
  score: number;
  first_name: string | null;
  username: string | null;
  tg_user_id: number;
  updated_at: string;
  hot_signal_at: string | null;
}

export async function renderLeads(db: D1Database): Promise<string> {
  const stages = await db.prepare("SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage").all<{ stage: string; n: number }>();
  const byStage = Object.fromEntries(stages.results.map((r) => [r.stage, r.n]));
  const order = ["VISITOR", "LEAD", "ENGAGED", "INTERESTED", "QUALIFIED", "CONTACTED", "NOT_QUALIFIED"];
  const summary = order.map((s) => `${STAGE_NAMES[s]}: ${byStage[s] ?? 0}`).join(" · ");
  const recent = await db
    .prepare(
      `SELECT l.stage, l.score, l.updated_at, l.hot_signal_at, u.first_name, u.username, u.tg_user_id
         FROM leads l JOIN users u ON u.id = l.user_id
        WHERE l.stage IN ('INTERESTED','QUALIFIED','CONTACTED') OR l.hot_signal_at IS NOT NULL
        ORDER BY l.updated_at DESC LIMIT 15`,
    )
    .all<LeadRow>();
  const lines = recent.results.map((l) => {
    const who = l.username ? `@${escapeHtml(l.username)}` : `<a href="tg://user?id=${l.tg_user_id}">${escapeHtml(l.first_name ?? "без имени")}</a>`;
    return `• ${who}: ${STAGE_NAMES[l.stage] ?? l.stage}, баллы ${l.score}${l.hot_signal_at ? " 🌡" : ""} · ${l.updated_at.slice(0, 10)}`;
  });
  return `<b>🔥 Лиды</b>\n\n${summary}\n\n<b>Последние тёплые</b>\n${lines.join("\n") || "пока нет"}\n\n🌡 = взял несколько PDF (сигнал, не гарантия покупки)`;
}

const SLOT_STATUS: Record<string, string> = {
  READY: "готов",
  DELIVERED: "ждёт публикации",
  PUBLISHED: "опубликован",
  RESEARCHING: "готовится",
  WAITING_EQUIPMENT: "ждёт выбора станка",
  EQUIPMENT: "ищу станки",
  SKIPPED: "пропуск",
  FAILED: "не получилось",
  PLANNED: "в плане",
  REJECTED: "отклонён",
};

export async function renderDailyReport(db: D1Database, now: Date, localDate = now.toISOString().slice(0, 10)): Promise<string> {
  const since = daysAgo(now, 1);
  const [day, week, spend] = await Promise.all([periodStats(db, since), periodStats(db, daysAgo(now, 7)), aiSpend(db, daysAgo(now, 7))]);
  const qualified = await db
    .prepare(
      `SELECT u.first_name, u.username, u.tg_user_id FROM funnel_events fe JOIN users u ON u.id = fe.user_id
        WHERE fe.type = 'QUALIFIED' AND fe.created_at >= ? ORDER BY fe.id`,
    )
    .bind(since)
    .all<{ first_name: string | null; username: string | null; tg_user_id: number }>();
  const waiting = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM content_items WHERE status = 'PREVIEW'"),
    db.prepare("SELECT COUNT(*) AS n FROM research_items WHERE status = 'IN_REVIEW'"),
    db.prepare("SELECT COUNT(*) AS n FROM content_items WHERE status = 'PUBLISHED' AND published_at >= ?").bind(since),
  ]);
  const w = (i: number) => waiting[i]?.results[0]?.n ?? 0;
  const who = qualified.results
    .map((u) => (u.username ? `@${escapeHtml(u.username)}` : `<a href="tg://user?id=${u.tg_user_id}">${escapeHtml(u.first_name ?? "без имени")}</a>`))
    .join(", ");
  const today = await db
    .prepare("SELECT rubric, status FROM plan_slots WHERE slot_date = ? AND plan_id IS NOT NULL")
    .bind(localDate)
    .all<{ rubric: Rubric; status: string }>();
  const plan = today.results.map((s) => `${RUBRIC_RU[s.rubric]} (${SLOT_STATUS[s.status] ?? s.status})`).join(", ");
  return (
    `☀️ <b>Утренний отчёт</b>\n\n${plan ? `🗓 Сегодня по плану: ${plan}\n\n` : ""}<b>За сутки</b>\n${funnelLines(day)}\n` +
    (who ? `🔥 Новые квалифицированные: ${who}\n` : "") +
    `Опубликовано постов: ${w(2)}\n\n` +
    `<b>За 7 дней</b>\nВходы ${week.starts} · PDF ${week.pdfs} · интерес ${week.interested} · квал. ${week.qualified}\n` +
    `Лучшие посты: \n${campaignLines(await topCampaigns(db, daysAgo(now, 7), 3))}\n\n` +
    `Ждут вашего решения: постов ${w(0)}, PDF ${w(1)}\n` +
    `AI за 7 дней: запусков ${spend.runs}, ≈$${spend.usd.toFixed(2)}`
  );
}

/** Once a day after REPORT_HOUR local time. */
export async function runDailyReport(ctx: { db: D1Database; tg: Telegram; admins: Set<number>; now: Date; timeZone: string }): Promise<boolean> {
  const local = localTime(ctx.now, ctx.timeZone);
  if (local.hour < REPORT_HOUR) return false;
  if ((await getSetting<string>(ctx.db, REPORT_SETTING)) === local.date) return false;
  await putSetting(ctx.db, REPORT_SETTING, local.date);
  const text = await renderDailyReport(ctx.db, ctx.now, local.date);
  for (const adminId of ctx.admins) {
    await sendMessage(ctx.tg, adminId, text).catch((e) => log.error("report.failed", e, { admin: adminId }));
  }
  return true;
}

// ---------- Monthly report ----------

export const MONTHLY_SETTING = "report.monthly_last";

/** First day of the month, 09:00 local: last month by rubric, best posts, rejections, AI spend, what to do more / less / test. */
export async function renderMonthlyReport(db: D1Database, month: string): Promise<string> {
  const since = `${month}-01T00:00:00.000Z`;
  const [y, m] = month.split("-").map(Number) as [number, number];
  const until = new Date(Date.UTC(y, m, 1)).toISOString();
  const rubrics = await rubricStats(db, since, until);
  const best = await db
    .prepare(
      `SELECT ci.topic, ci.rubric, ci.views, SUM(fe.type = 'START') AS starts, SUM(fe.type = 'INTERESTED') AS interested, SUM(fe.type = 'QUALIFIED') AS qualified
         FROM content_items ci LEFT JOIN funnels f ON f.content_item_id = ci.id LEFT JOIN funnel_events fe ON fe.funnel_id = f.id
        WHERE ci.status = 'PUBLISHED' AND ci.published_at >= ? AND ci.published_at < ?
        GROUP BY ci.id ORDER BY qualified DESC, interested DESC, starts DESC, ci.views DESC LIMIT 3`,
    )
    .bind(since, until)
    .all<{ topic: string | null; rubric: string; views: number | null; starts: number; interested: number; qualified: number }>();
  const rejected = await db
    .prepare("SELECT reject_reason AS reason, COUNT(*) AS n FROM content_items WHERE reject_reason IS NOT NULL AND created_at >= ? AND created_at < ? GROUP BY reject_reason ORDER BY n DESC")
    .bind(since, until)
    .all<{ reason: string; n: number }>();
  const formats = await db
    .prepare("SELECT format, COUNT(*) AS n FROM content_items WHERE status = 'PUBLISHED' AND format IS NOT NULL AND published_at >= ? AND published_at < ? GROUP BY format")
    .bind(since, until)
    .all<{ format: string; n: number }>();
  const spend = await aiSpend(db, since).then(async (all) => {
    const after = await aiSpend(db, until);
    return all.usd - after.usd;
  });

  const totalStarts = rubrics.reduce((s, r) => s + r.starts, 0);
  const perPost = (r: RubricRow) => (r.interested + r.qualified * 2) / Math.max(1, r.posts);
  const withLinks = rubrics.filter((r) => r.posts >= 2 && (r.rubric === "BUSINESS_MODEL" || r.rubric === "OPPORTUNITY" || r.starts > 0));
  const more = [...withLinks].sort((a, b) => perPost(b) - perPost(a))[0];
  const less = withLinks.length > 1 ? [...withLinks].sort((a, b) => perPost(a) - perPost(b))[0] : undefined;
  const used = new Set(formats.results.map((f) => f.format));
  const untested = ["CHECKLIST", "XATO", "RAW_MATERIAL", "MACHINE", "TREND", "POLL"].filter((f) => !used.has(f)).slice(0, 2);

  const lines = [
    `📅 <b>Отчёт за ${month}</b>`,
    `<b>По рубрикам</b>\n${rubricLines(rubrics)}`,
    `<b>Лучшие посты</b>\n${best.results.map((b, i) => `${i + 1}. ${escapeHtml(b.topic ?? "пост")} (${RUBRIC_RU[b.rubric as Rubric] ?? b.rubric}): входы ${b.starts}, интерес ${b.interested}, квал. ${b.qualified}${b.views ? `, просмотры ${b.views}` : ""}`).join("\n") || "пока нет"}`,
    rejected.results.length ? `<b>Почему отклоняли</b>\n${rejected.results.map((r) => `• ${escapeHtml(r.reason)}: ${r.n}`).join("\n")}` : "",
    `<b>Выводы</b> (считает код по лидам, не по просмотрам)\n` +
      `➕ Больше: ${more ? `${RUBRIC_RU[more.rubric]} (лучше всего приводит к интересу и квалификации)` : "мало данных"}\n` +
      `➖ Меньше: ${less && less !== more ? RUBRIC_RU[less.rubric] : "мало данных"}\n` +
      `🧪 Протестировать: ${untested.join(", ") || "все форматы уже пробовали"}`,
    totalStarts < 30 ? "⚠️ Входов в бота меньше 30: выводы ненадёжные, это ориентир, а не правило." : "",
    `AI за месяц: ≈$${spend.toFixed(2)}`,
  ];
  return lines.filter(Boolean).join("\n\n");
}

export async function runMonthlyReport(ctx: { db: D1Database; tg: Telegram; admins: Set<number>; now: Date; timeZone: string }): Promise<boolean> {
  const local = localTime(ctx.now, ctx.timeZone);
  if (!local.date.endsWith("-01") || local.hour < REPORT_HOUR) return false;
  const [y, m] = local.date.split("-").map(Number) as [number, number];
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  if ((await getSetting<string>(ctx.db, MONTHLY_SETTING)) === prev) return false;
  await putSetting(ctx.db, MONTHLY_SETTING, prev);
  const text = await renderMonthlyReport(ctx.db, prev);
  for (const adminId of ctx.admins) {
    await sendMessage(ctx.tg, adminId, text).catch((e) => log.error("report.monthly_failed", e, { admin: adminId }));
  }
  return true;
}
