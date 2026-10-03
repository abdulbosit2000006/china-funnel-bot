// Post views. The Bot API does not give channel post views, so once a week (with the Saturday plan) the founder
// types them from the channel in one message; statistics then show views next to bot entries and leads.
import { getSetting, putSetting } from "../db";
import { dayShort } from "../content/calendar";
import { RUBRIC_RU, type Rubric } from "../content/model";
import { escapeHtml, sendMessage } from "../telegram/api";
import type { ContentCtx } from "./plan";

const VIEWS_SETTING = (adminId: number) => `await.views.${adminId}`;

interface PublishedRow {
  id: number;
  rubric: Rubric | null;
  topic: string | null;
  published_at: string;
  views: number | null;
}

async function lastWeekPosts(db: D1Database, now: Date): Promise<PublishedRow[]> {
  return (
    await db
      .prepare("SELECT id, rubric, topic, published_at, views FROM content_items WHERE status = 'PUBLISHED' AND published_at >= ? ORDER BY published_at")
      .bind(new Date(now.getTime() - 8 * 86_400_000).toISOString())
      .all<PublishedRow>()
  ).results;
}

/** Asks for the week's views. Silent when nothing was published. */
export async function sendViewsRequest(ctx: ContentCtx, chatId: number): Promise<boolean> {
  const posts = await lastWeekPosts(ctx.db, ctx.now);
  if (!posts.length) return false;
  await putSetting(ctx.db, VIEWS_SETTING(chatId), posts.map((p) => p.id));
  const lines = posts.map(
    (p, i) => `${i + 1}. ${dayShort(p.published_at.slice(0, 10))} · ${p.rubric ? RUBRIC_RU[p.rubric] : "пост"}: ${escapeHtml((p.topic ?? "").slice(0, 60))}${p.views !== null ? ` (сейчас ${p.views})` : ""}`,
  );
  await sendMessage(
    ctx.tg,
    chatId,
    `👁 <b>Просмотры за неделю</b>\nTelegram не отдаёт боту просмотры, поэтому пришлите их из канала одним сообщением, числа по порядку через пробел:\n\n${lines.join("\n")}\n\nНапример: <code>${posts.map((_, i) => 800 + i * 150).join(" ")}</code>\nМожно позже командой <code>/views</code>.`,
  );
  return true;
}

/** /views: the same request on demand. */
export async function handleViewsCommand(ctx: ContentCtx, chatId: number): Promise<void> {
  if (!(await sendViewsRequest(ctx, chatId))) await sendMessage(ctx.tg, chatId, "За последнюю неделю опубликованных постов нет.");
}

/** Numbers in reply to the request. Returns true when the text was consumed. */
export async function handleViewsText(ctx: ContentCtx, adminId: number, chatId: number, text: string): Promise<boolean> {
  if (!/^[\d\s.,]+$/.test(text.trim())) return false;
  const ids = await getSetting<number[]>(ctx.db, VIEWS_SETTING(adminId));
  if (!ids?.length) return false;
  const numbers = text.trim().split(/\s+/).map((n) => Number(n.replace(/[.,]/g, "")));
  if (numbers.some((n) => !Number.isFinite(n) || n < 0) || numbers.length > ids.length) {
    await sendMessage(ctx.tg, chatId, `Нужно не больше ${ids.length} чисел через пробел, по порядку списка.`);
    return true;
  }
  await ctx.db.batch(numbers.map((n, i) => ctx.db.prepare("UPDATE content_items SET views = ? WHERE id = ?").bind(Math.round(n), ids[i]!)));
  await ctx.db.prepare("DELETE FROM settings WHERE key = ?").bind(VIEWS_SETTING(adminId)).run();
  await sendMessage(ctx.tg, chatId, `✅ Записал просмотры для ${numbers.length} постов. Они в статистике и в месячном отчёте.`);
  return true;
}
