import type { TgUser } from "./telegram/types";

export type FunnelEventType =
  | "START" | "PDF_SENT" | "CTA_CLICK" | "FOLLOWUP_SENT" | "FOLLOWUP_REPLY" | "INTERESTED"
  | "QUESTION" | "NOT_NOW" | "QUAL_ANSWER" | "QUALIFIED" | "HOT_SIGNAL" | "CONTACTED"
  | "NOT_QUALIFIED" | "OPT_OUT";

export interface UserRow {
  id: number;
  tg_user_id: number;
  username: string | null;
  first_name: string | null;
  first_source: string | null;
  is_blocked_bot: number;
}

export interface FunnelRow {
  id: number;
  code: string;
  kind: string;
  lead_magnet_slug: string | null;
}

const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));

/** Returns false when this update_id was already processed (Telegram redelivery). */
export async function claimUpdate(db: D1Database, updateId: number, now: string): Promise<boolean> {
  const result = await db
    .prepare("INSERT INTO processed_updates (update_id, received_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
    .bind(updateId, now)
    .run();
  return result.meta.changes > 0;
}

export async function deleteOldUpdates(db: D1Database, before: string): Promise<number> {
  const result = await db.prepare("DELETE FROM processed_updates WHERE received_at < ?").bind(before).run();
  return result.meta.changes;
}

/** Creates the user on first contact and refreshes profile fields afterwards. */
export async function upsertUser(
  db: D1Database,
  from: TgUser,
  now: string,
  firstSource: { code: string; funnelId: number | null } | null,
): Promise<{ user: UserRow; isNew: boolean }> {
  const language = from.language_code?.startsWith("ru") ? "ru" : "uz";
  const inserted = await db
    .prepare(
      `INSERT INTO users (tg_user_id, username, first_name, language, first_source, first_funnel_id,
                          created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tg_user_id) DO NOTHING`,
    )
    .bind(from.id, from.username ?? null, from.first_name, language, firstSource?.code ?? null,
      firstSource?.funnelId ?? null, now, now)
    .run();
  const isNew = inserted.meta.changes > 0;
  if (!isNew) {
    await db
      .prepare(
        "UPDATE users SET username = ?, first_name = ?, last_seen_at = ?, is_blocked_bot = 0 WHERE tg_user_id = ?",
      )
      .bind(from.username ?? null, from.first_name, now, from.id)
      .run();
  }
  const user = await db.prepare("SELECT * FROM users WHERE tg_user_id = ?").bind(from.id).first<UserRow>();
  if (!user) throw new Error("user row missing after upsert");
  if (isNew) {
    await db
      .prepare("INSERT INTO leads (user_id, stage, last_funnel_id, updated_at) VALUES (?, 'VISITOR', ?, ?)")
      .bind(user.id, firstSource?.funnelId ?? null, now)
      .run();
  }
  return { user, isNew };
}

export async function setBlocked(db: D1Database, tgUserId: number, blocked: boolean): Promise<void> {
  await db.prepare("UPDATE users SET is_blocked_bot = ? WHERE tg_user_id = ?").bind(blocked ? 1 : 0, tgUserId).run();
}

export function findActiveFunnel(db: D1Database, code: string): Promise<FunnelRow | null> {
  return db
    .prepare("SELECT id, code, kind, lead_magnet_slug FROM funnels WHERE code = ? AND active = 1")
    .bind(code)
    .first<FunnelRow>();
}

export async function touchLeadFunnel(db: D1Database, userId: number, funnelId: number, now: string): Promise<void> {
  await db.prepare("UPDATE leads SET last_funnel_id = ?, updated_at = ? WHERE user_id = ?").bind(funnelId, now, userId).run();
}

export async function recordFunnelEvent(
  db: D1Database,
  event: { userId: number; type: FunnelEventType; funnelId?: number | null; leadMagnetId?: number | null; payload?: unknown },
  now: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO funnel_events (user_id, funnel_id, lead_magnet_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(event.userId, event.funnelId ?? null, event.leadMagnetId ?? null, event.type, json(event.payload), now)
    .run();
}

export async function recordAnalytics(
  db: D1Database,
  name: string,
  now: string,
  extra: { userId?: number; funnelId?: number; props?: unknown } = {},
): Promise<void> {
  await db
    .prepare("INSERT INTO analytics_events (name, user_id, funnel_id, props, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(name, extra.userId ?? null, extra.funnelId ?? null, json(extra.props), now)
    .run();
}

export async function logAdminAction(
  db: D1Database,
  adminTgId: number,
  action: string,
  now: string,
  details?: unknown,
): Promise<void> {
  await db
    .prepare("INSERT INTO admin_actions (admin_tg_id, action, details, created_at) VALUES (?, ?, ?, ?)")
    .bind(adminTgId, action, json(details), now)
    .run();
}

export interface DashboardStats {
  usersTotal: number;
  usersNew24h: number;
  starts24h: number;
  stages: Record<string, number>;
}

export async function dashboardStats(db: D1Database, since24h: string): Promise<DashboardStats> {
  const [total, fresh, starts, stages] = await db.batch<{ n: number; stage?: string }>([
    db.prepare("SELECT COUNT(*) AS n FROM users"),
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?").bind(since24h),
    db.prepare("SELECT COUNT(*) AS n FROM funnel_events WHERE type = 'START' AND created_at >= ?").bind(since24h),
    db.prepare("SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage"),
  ]);
  const byStage: Record<string, number> = {};
  for (const row of stages?.results ?? []) if (row.stage) byStage[row.stage] = row.n;
  return {
    usersTotal: total?.results[0]?.n ?? 0,
    usersNew24h: fresh?.results[0]?.n ?? 0,
    starts24h: starts?.results[0]?.n ?? 0,
    stages: byStage,
  };
}
