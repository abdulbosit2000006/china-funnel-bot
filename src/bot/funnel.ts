import {
  type FunnelRow,
  type UserRow,
  addScore,
  advanceStage,
  distinctMagnetsReceived,
  getActiveLeadMagnet,
  getLeadMagnet,
  hasEvent,
  recordFunnelEvent,
} from "../db";
import { log } from "../log";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import type { TgCallbackQuery, TgUser } from "../telegram/types";
import { template } from "./templates";

export const CTA_CALLBACK_PREFIX = "cta:";

export interface FunnelContext {
  db: D1Database;
  tg: Telegram;
  admins: Set<number>;
  now: Date;
}

/** Campaign link opened: send the live PDF of its lead magnet, then the service offer. */
export async function deliverLeadMagnet(
  ctx: FunnelContext,
  chatId: number,
  user: UserRow,
  funnel: FunnelRow,
): Promise<boolean> {
  const magnet = funnel.lead_magnet_slug ? await getActiveLeadMagnet(ctx.db, funnel.lead_magnet_slug) : null;
  if (!magnet?.tg_file_id) return false;
  const now = ctx.now.toISOString();
  const firstTime = !(await hasEvent(ctx.db, user.id, "PDF_SENT", magnet.id));

  await sendMessage(ctx.tg, chatId, await template(ctx.db, "intro"));
  await ctx.tg.call("sendDocument", {
    chat_id: chatId,
    document: magnet.tg_file_id,
    caption: magnet.title.slice(0, 1000),
  });
  await recordFunnelEvent(
    ctx.db,
    { userId: user.id, type: "PDF_SENT", funnelId: funnel.id, leadMagnetId: magnet.id, payload: { version: magnet.version } },
    now,
  );
  await advanceStage(ctx.db, user.id, "LEAD", now);
  if (firstTime) await addScore(ctx.db, user.id, 1, now);
  if ((await distinctMagnetsReceived(ctx.db, user.id)) >= 2) await advanceStage(ctx.db, user.id, "ENGAGED", now);

  await sendMessage(ctx.tg, chatId, await template(ctx.db, "serviceCta"), [
    [{ text: await template(ctx.db, "ctaButton"), callback_data: `${CTA_CALLBACK_PREFIX}${magnet.id}:${funnel.id}` }],
  ]);
  // Phase 3: schedule the single follow-up for this PDF here.
  return true;
}

function personLink(user: TgUser): string {
  const name = escapeHtml(user.first_name);
  return user.username ? `${name} (@${escapeHtml(user.username)})` : `<a href="tg://user?id=${user.id}">${name}</a>`;
}

/** "Muhokama qilmoqchiman" pressed: mark interest once and tell the founder. */
export async function handleCtaClick(ctx: FunnelContext, callback: TgCallbackQuery, user: UserRow): Promise<void> {
  const [rawMagnetId, rawFunnelId] = (callback.data ?? "").slice(CTA_CALLBACK_PREFIX.length).split(":");
  const magnet = await getLeadMagnet(ctx.db, Number(rawMagnetId));
  const funnelId = Number(rawFunnelId) || null;
  const chatId = callback.message?.chat.id ?? callback.from.id;
  await ctx.tg.call("answerCallbackQuery", { callback_query_id: callback.id });
  if (!magnet) return;

  if (await hasEvent(ctx.db, user.id, "CTA_CLICK", magnet.id)) {
    await sendMessage(ctx.tg, chatId, await template(ctx.db, "ctaAlready"));
    return;
  }
  const now = ctx.now.toISOString();
  await recordFunnelEvent(ctx.db, { userId: user.id, type: "CTA_CLICK", funnelId, leadMagnetId: magnet.id }, now);
  await recordFunnelEvent(ctx.db, { userId: user.id, type: "INTERESTED", funnelId, leadMagnetId: magnet.id }, now);
  await advanceStage(ctx.db, user.id, "INTERESTED", now);
  await addScore(ctx.db, user.id, 3, now);
  await sendMessage(ctx.tg, chatId, await template(ctx.db, "ctaThanks"));

  const history = await ctx.db
    .prepare(
      `SELECT DISTINCT lm.title FROM funnel_events fe JOIN lead_magnets lm ON lm.id = fe.lead_magnet_id
        WHERE fe.user_id = ? AND fe.type = 'PDF_SENT' ORDER BY fe.id`,
    )
    .bind(user.id)
    .all<{ title: string }>();
  const funnel = funnelId
    ? await ctx.db.prepare("SELECT code FROM funnels WHERE id = ?").bind(funnelId).first<{ code: string }>()
    : null;
  const card =
    `🔥 <b>Клиент хочет обсудить</b>\n\n` +
    `Кто: ${personLink(callback.from)}\n` +
    `Материал: ${escapeHtml(magnet.title)} (v${magnet.version})\n` +
    `Кампания: <code>${escapeHtml(funnel?.code ?? "—")}</code>\n` +
    `Все PDF: ${history.results.map((r) => escapeHtml(r.title)).join("; ") || "—"}\n` +
    `Время: ${now.slice(0, 16).replace("T", " ")} UTC`;
  const openChat = callback.from.username
    ? `https://t.me/${callback.from.username}`
    : `tg://user?id=${callback.from.id}`;
  for (const adminId of ctx.admins) {
    try {
      await sendMessage(ctx.tg, adminId, card, [[{ text: "💬 Открыть чат", url: openChat }]]);
    } catch (error) {
      log.error("admin.notify_failed", error, { admin: adminId });
    }
  }
}
