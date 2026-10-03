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
  pdfs24h: number;
  cta24h: number;
  stages: Record<string, number>;
}

export async function dashboardStats(db: D1Database, since24h: string): Promise<DashboardStats> {
  const [total, fresh, starts, stages, pdfs, ctas] = await db.batch<{ n: number; stage?: string }>([
    db.prepare("SELECT COUNT(*) AS n FROM users"),
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?").bind(since24h),
    db.prepare("SELECT COUNT(*) AS n FROM funnel_events WHERE type = 'START' AND created_at >= ?").bind(since24h),
    db.prepare("SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage"),
    db.prepare("SELECT COUNT(*) AS n FROM funnel_events WHERE type = 'PDF_SENT' AND created_at >= ?").bind(since24h),
    db.prepare("SELECT COUNT(*) AS n FROM funnel_events WHERE type = 'CTA_CLICK' AND created_at >= ?").bind(since24h),
  ]);
  const byStage: Record<string, number> = {};
  for (const row of stages?.results ?? []) if (row.stage) byStage[row.stage] = row.n;
  return {
    usersTotal: total?.results[0]?.n ?? 0,
    usersNew24h: fresh?.results[0]?.n ?? 0,
    starts24h: starts?.results[0]?.n ?? 0,
    pdfs24h: pdfs?.results[0]?.n ?? 0,
    cta24h: ctas?.results[0]?.n ?? 0,
    stages: byStage,
  };
}

// ---------- Lead magnets ----------

export const LEAD_MAGNET_TYPES = [
  "EXHIBITION_GUIDE",
  "MANUFACTURING_MODEL",
  "MACHINERY_GUIDE",
  "RAW_MATERIAL_GUIDE",
] as const;
export type LeadMagnetType = (typeof LEAD_MAGNET_TYPES)[number];

export interface LeadMagnetRow {
  id: number;
  slug: string;
  version: number;
  type: LeadMagnetType;
  title: string;
  status: "DRAFT" | "APPROVED" | "ACTIVE" | "OUTDATED" | "ARCHIVED";
  r2_key: string | null;
  tg_file_id: string | null;
  file_sha256: string | null;
  created_at: string;
}

export async function createLeadMagnetVersion(
  db: D1Database,
  input: {
    slug: string;
    version: number;
    title: string;
    type: LeadMagnetType;
    r2Key: string;
    tgFileId: string;
  },
  now: string,
): Promise<LeadMagnetRow> {
  const row = await db
    .prepare(
      `INSERT INTO lead_magnets (slug, version, type, title, status, r2_key, tg_file_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'DRAFT', ?5, ?6, ?7, ?7)
       RETURNING *`,
    )
    .bind(input.slug, input.version, input.type, input.title, input.r2Key, input.tgFileId, now)
    .first<LeadMagnetRow>();
  if (!row) throw new Error("lead magnet insert failed");
  return row;
}

export function nextLeadMagnetVersion(db: D1Database, slug: string): Promise<number> {
  return db
    .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM lead_magnets WHERE slug = ?")
    .bind(slug)
    .first<{ v: number }>()
    .then((r) => r?.v ?? 1);
}

export function latestLeadMagnet(db: D1Database, slug: string): Promise<LeadMagnetRow | null> {
  return db.prepare("SELECT * FROM lead_magnets WHERE slug = ? ORDER BY version DESC LIMIT 1").bind(slug).first<LeadMagnetRow>();
}

export function getLeadMagnet(db: D1Database, id: number): Promise<LeadMagnetRow | null> {
  return db.prepare("SELECT * FROM lead_magnets WHERE id = ?").bind(id).first<LeadMagnetRow>();
}

export function getActiveLeadMagnet(db: D1Database, slug: string): Promise<LeadMagnetRow | null> {
  return db
    .prepare("SELECT * FROM lead_magnets WHERE slug = ? AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1")
    .bind(slug)
    .first<LeadMagnetRow>();
}

export async function setLeadMagnetType(db: D1Database, id: number, type: LeadMagnetType, now: string): Promise<void> {
  await db.prepare("UPDATE lead_magnets SET type = ?, updated_at = ? WHERE id = ?").bind(type, now, id).run();
}

/** Makes this version the live one; the previous live version of the slug becomes OUTDATED (kept, not deleted). */
export async function activateLeadMagnet(db: D1Database, magnet: LeadMagnetRow, now: string): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE lead_magnets SET status = 'OUTDATED', updated_at = ? WHERE slug = ? AND status = 'ACTIVE' AND id != ?")
      .bind(now, magnet.slug, magnet.id),
    db.prepare("UPDATE lead_magnets SET status = 'ACTIVE', updated_at = ? WHERE id = ?").bind(now, magnet.id),
  ]);
}

export async function archiveLeadMagnet(db: D1Database, id: number, now: string): Promise<void> {
  await db.prepare("UPDATE lead_magnets SET status = 'ARCHIVED', updated_at = ? WHERE id = ?").bind(now, id).run();
}

export interface LeadMagnetSummary {
  slug: string;
  id: number;
  version: number;
  title: string;
  status: string;
  deliveries: number;
}

/** Latest version of every slug with its total delivery count (all versions). */
export async function listLeadMagnets(db: D1Database): Promise<LeadMagnetSummary[]> {
  const rows = await db
    .prepare(
      `SELECT lm.slug, lm.id, lm.version, lm.title, lm.status,
              (SELECT COUNT(*) FROM funnel_events fe JOIN lead_magnets x ON x.id = fe.lead_magnet_id
                WHERE x.slug = lm.slug AND fe.type = 'PDF_SENT') AS deliveries
         FROM lead_magnets lm
        WHERE lm.status != 'ARCHIVED'
          AND lm.version = (SELECT MAX(version) FROM lead_magnets y WHERE y.slug = lm.slug AND y.status != 'ARCHIVED')
        ORDER BY lm.updated_at DESC
        LIMIT 30`,
    )
    .all<LeadMagnetSummary>();
  return rows.results;
}

// ---------- Campaigns (funnels) ----------

export async function createFunnelForSlug(
  db: D1Database,
  slug: string,
  kind: string,
  now: string,
): Promise<FunnelRow> {
  const base = slug.replace(/-/g, "_").slice(0, 50);
  const { n } = (await db.prepare("SELECT COUNT(*) AS n FROM funnels WHERE lead_magnet_slug = ?").bind(slug).first<{ n: number }>()) ?? { n: 0 };
  const code = `${base}_c${n + 1}`;
  const row = await db
    .prepare(
      "INSERT INTO funnels (code, kind, lead_magnet_slug, created_at) VALUES (?, ?, ?, ?) RETURNING id, code, kind, lead_magnet_slug",
    )
    .bind(code, kind, slug, now)
    .first<FunnelRow>();
  if (!row) throw new Error("funnel insert failed");
  return row;
}

export async function funnelsForSlug(db: D1Database, slug: string): Promise<(FunnelRow & { starts: number })[]> {
  const rows = await db
    .prepare(
      `SELECT f.id, f.code, f.kind, f.lead_magnet_slug,
              (SELECT COUNT(*) FROM funnel_events fe WHERE fe.funnel_id = f.id AND fe.type = 'START') AS starts
         FROM funnels f WHERE f.lead_magnet_slug = ? AND f.active = 1 ORDER BY f.id DESC LIMIT 10`,
    )
    .bind(slug)
    .all<FunnelRow & { starts: number }>();
  return rows.results;
}

// ---------- Lead stage (forward only) ----------

export const STAGE_ORDER = ["VISITOR", "LEAD", "ENGAGED", "INTERESTED", "QUALIFIED", "CONTACTED"] as const;
export type Stage = (typeof STAGE_ORDER)[number];

/** Moves the lead forward to `target`; never moves it back and never touches NOT_QUALIFIED. */
export async function advanceStage(db: D1Database, userId: number, target: Stage, now: string): Promise<boolean> {
  const rank = STAGE_ORDER.indexOf(target);
  const lower = STAGE_ORDER.slice(0, rank);
  if (lower.length === 0) return false;
  const placeholders = lower.map(() => "?").join(",");
  const result = await db
    .prepare(`UPDATE leads SET stage = ?, updated_at = ? WHERE user_id = ? AND stage IN (${placeholders})`)
    .bind(target, now, userId, ...lower)
    .run();
  return result.meta.changes > 0;
}

export function distinctMagnetsReceived(db: D1Database, userId: number): Promise<number> {
  return db
    .prepare(
      `SELECT COUNT(DISTINCT lm.slug) AS n FROM funnel_events fe JOIN lead_magnets lm ON lm.id = fe.lead_magnet_id
        WHERE fe.user_id = ? AND fe.type = 'PDF_SENT'`,
    )
    .bind(userId)
    .first<{ n: number }>()
    .then((r) => r?.n ?? 0);
}

export async function addScore(db: D1Database, userId: number, points: number, now: string): Promise<void> {
  await db.prepare("UPDATE leads SET score = score + ?, updated_at = ? WHERE user_id = ?").bind(points, now, userId).run();
}

export async function hasEvent(db: D1Database, userId: number, type: FunnelEventType, leadMagnetId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM funnel_events WHERE user_id = ? AND type = ? AND lead_magnet_id = ? LIMIT 1")
    .bind(userId, type, leadMagnetId)
    .first();
  return row !== null;
}

// ---------- Settings ----------

export async function getSetting<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

export async function putSetting(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value))
    .run();
}

export function getUserById(db: D1Database, id: number): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}
