// The founder's exhibition list (Abdul, 2026-10-03: first he gives the exhibitions he can organize; the bot
// later proposes similar ones and he confirms) and the channel mode NORMAL / EXHIBITION_SEASON.
import { wasSeen } from "../ai/openai";
import { logAdminAction, putSetting } from "../db";
import { daysBetween, dayLabel } from "../content/calendar";
import { escapeHtml, sendMessage } from "../telegram/api";
import { localTime } from "../time";
import { MODE_SETTING, channelMode, type ChannelMode, type ContentCtx } from "./plan";

export interface SimilarExhibition {
  name: string;
  city?: string;
  why?: string;
  source_url?: string;
}

interface ExpoRow {
  id: number;
  name: string;
  city: string | null;
  starts_on: string | null;
  ends_on: string | null;
}

/** The season is proposed when a listed exhibition starts in 4–12 weeks. */
const SEASON_FROM_DAYS = 28;
const SEASON_TO_DAYS = 84;

export async function confirmedExhibitions(db: D1Database): Promise<ExpoRow[]> {
  return (await db.prepare("SELECT id, name, city, starts_on, ends_on FROM exhibition_calendar WHERE status = 'CONFIRMED' ORDER BY COALESCE(starts_on, '9999'), id").all<ExpoRow>()).results;
}

/** Dates the plan run found on official sites; only pages the search returned are trusted. */
export async function updateExhibitionDates(db: D1Database, raw: unknown, seen: Set<string>, now: Date): Promise<void> {
  if (!Array.isArray(raw)) return;
  const list = await confirmedExhibitions(db);
  const iso = (x: unknown) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
  for (const d of raw as { name?: string; starts_on?: string; ends_on?: string; city?: string; official_site?: string; source_url?: string }[]) {
    if (!d?.name || !iso(d.starts_on) || !d.source_url || !wasSeen(d.source_url, seen)) continue;
    const row = list.find((e) => e.name.toLowerCase() === d.name!.toLowerCase());
    if (!row) continue;
    await db
      .prepare("UPDATE exhibition_calendar SET starts_on = ?, ends_on = ?, city = COALESCE(city, ?), official_site = ?, source_url = ?, updated_at = ? WHERE id = ?")
      .bind(iso(d.starts_on), iso(d.ends_on), d.city ?? null, d.official_site ?? null, d.source_url, now.toISOString(), row.id)
      .run();
  }
}

/** A line for the plan: switch the season on or off. The bot only proposes, the founder switches. */
export async function seasonHint(db: D1Database, mode: ChannelMode, now: Date): Promise<string | null> {
  const today = now.toISOString().slice(0, 10);
  const upcoming = (await confirmedExhibitions(db)).filter((e) => e.starts_on && daysBetween(today, e.starts_on) >= 0);
  const soon = upcoming.filter((e) => {
    const d = daysBetween(today, e.starts_on!);
    return d >= SEASON_FROM_DAYS && d <= SEASON_TO_DAYS;
  });
  if (mode === "NORMAL" && soon.length) {
    return `🎪 Через 4–12 недель: ${soon.map((e) => `${escapeHtml(e.name)} (${dayLabel(e.starts_on!)})`).join(", ")}. Предлагаю включить сезон выставок (по пятницам выставки): <code>/season on</code>`;
  }
  if (mode === "EXHIBITION_SEASON" && !upcoming.some((e) => daysBetween(today, e.starts_on!) <= SEASON_TO_DAYS)) {
    return `🎪 В ближайшие 12 недель выставок из вашего списка нет. Предлагаю вернуть обычный режим: <code>/season off</code>`;
  }
  return null;
}

/** /expo — list; /expo <one or more lines> — add; /expo del <id> — remove. */
export async function handleExpoCommand(ctx: ContentCtx, chatId: number, adminId: number, arg: string): Promise<void> {
  const at = ctx.now.toISOString();
  const del = /^(del|удалить)\s+(\d+)$/i.exec(arg.trim());
  if (del) {
    await ctx.db.prepare("UPDATE exhibition_calendar SET status = 'REMOVED', updated_at = ? WHERE id = ?").bind(at, Number(del[2])).run();
    await logAdminAction(ctx.db, adminId, "expo.remove", at, { id: Number(del[2]) });
  } else if (arg.trim()) {
    const names = arg
      .split(/\n|;/)
      .map((l) => l.replace(/^\s*(add|добавить)\s+/i, "").replace(/^[\s\-•\d.)]+/, "").trim())
      .filter((l) => l.length >= 3)
      .slice(0, 30);
    for (const line of names) {
      const [name, city] = line.split(",").map((x) => x.trim());
      await ctx.db
        .prepare("INSERT INTO exhibition_calendar (name, city, status, created_at, updated_at) VALUES (?, ?, 'CONFIRMED', ?, ?)")
        .bind(name!.slice(0, 120), city?.slice(0, 60) || null, at, at)
        .run();
    }
    await logAdminAction(ctx.db, adminId, "expo.add", at, { names });
  }
  const list = await confirmedExhibitions(ctx.db);
  const mode = await channelMode(ctx.db);
  const lines = list.map((e) => `${e.id}. ${escapeHtml(e.name)}${e.city ? `, ${escapeHtml(e.city)}` : ""}${e.starts_on ? ` · ${dayLabel(e.starts_on)}` : " · даты найду при планировании"}`);
  await sendMessage(
    ctx.tg,
    chatId,
    `🎪 <b>Ваши выставки</b> (бот берёт выставки только отсюда)\n\n${lines.join("\n") || "Список пуст."}\n\n` +
      `Режим канала: <b>${mode === "EXHIBITION_SEASON" ? "сезон выставок" : "обычный"}</b>\n\n` +
      `Добавить: <code>/expo Canton Fair, Guangzhou</code> (можно несколько строк сразу)\nУбрать: <code>/expo del 3</code>\nСезон: <code>/season on</code> или <code>/season off</code>`,
  );
}

/** /season on|off: in the season Friday is always an exhibition from the list. */
export async function handleSeasonCommand(ctx: ContentCtx, chatId: number, adminId: number, arg: string): Promise<void> {
  const cmd = arg.trim().toLowerCase();
  if (cmd === "on" || cmd === "off") {
    const mode: ChannelMode = cmd === "on" ? "EXHIBITION_SEASON" : "NORMAL";
    await putSetting(ctx.db, MODE_SETTING, mode);
    await logAdminAction(ctx.db, adminId, `season.${cmd}`, ctx.now.toISOString());
  }
  const mode = await channelMode(ctx.db);
  const today = localTime(ctx.now, ctx.timeZone).date;
  const hint = await seasonHint(ctx.db, mode, new Date(`${today}T12:00:00Z`));
  await sendMessage(
    ctx.tg,
    chatId,
    `🎪 Режим канала: <b>${mode === "EXHIBITION_SEASON" ? "сезон выставок" : "обычный"}</b>.\n` +
      (mode === "EXHIBITION_SEASON"
        ? "По пятницам выставки из вашего списка, среда про подготовку к выставкам. Действует со следующего плана недели."
        : "Пятница: станки, сырьё, тренды; выставка не чаще раза в неделю.") +
      (hint ? `\n\n${hint}` : ""),
  );
}
