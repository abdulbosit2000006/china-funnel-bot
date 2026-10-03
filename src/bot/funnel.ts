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
import { sendMessage, type Telegram } from "../telegram/api";
import type { TgCallbackQuery } from "../telegram/types";
import { afterPdfDelivered, startInterest } from "./leads";
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
  await afterPdfDelivered(ctx, user, magnet, funnel.id);
  return true;
}

/** "Muhokama qilmoqchiman" pressed: interest, then the short qualification. */
export async function handleCtaClick(ctx: FunnelContext, callback: TgCallbackQuery, user: UserRow): Promise<void> {
  const [rawMagnetId, rawFunnelId] = (callback.data ?? "").slice(CTA_CALLBACK_PREFIX.length).split(":");
  const magnet = await getLeadMagnet(ctx.db, Number(rawMagnetId));
  const chatId = callback.message?.chat.id ?? callback.from.id;
  await ctx.tg.call("answerCallbackQuery", { callback_query_id: callback.id });
  if (!magnet) return;
  await startInterest(ctx, chatId, user, magnet, Number(rawFunnelId) || null, "cta");
}
