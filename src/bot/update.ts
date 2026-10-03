import { findActiveFunnel, recordAnalytics, recordFunnelEvent, setBlocked, touchLeadFunnel, upsertUser } from "../db";
import { sendMessage, type Telegram } from "../telegram/api";
import type { TgCallbackQuery, TgMessage, TgUpdate } from "../telegram/types";
import { ADMIN_CALLBACK_PREFIX, handleAdminCallback, sendAdminMenu } from "./admin";
import { CTA_CALLBACK_PREFIX, deliverLeadMagnet, handleCtaClick } from "./funnel";
import { MAGNET_CALLBACK_PREFIX, handleAdminUpload, handleMagnetCallback } from "./magnets";
import { RESEARCH_CALLBACK_PREFIX, handleResearchCallback, handleResearchUpload, isResearchFile } from "./research";
import { template } from "./templates";

export interface BotContext {
  db: D1Database;
  files: R2Bucket;
  tg: Telegram;
  admins: Set<number>;
  now: Date;
}

// Telegram deep-link payload rule: up to 64 characters of A-Z, a-z, 0-9, _ and -.
const PAYLOAD = /^[A-Za-z0-9_-]{1,64}$/;

export function parseStart(text: string): { isStart: boolean; payload: string | null } {
  const match = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (!match) return { isStart: false, payload: null };
  const payload = match[1] ?? null;
  return { isStart: true, payload: payload && PAYLOAD.test(payload) ? payload : null };
}

export async function handleUpdate(update: TgUpdate, ctx: BotContext): Promise<void> {
  if (update.message) return handleMessage(update.message, ctx);
  if (update.callback_query) return handleCallback(update.callback_query, ctx);
  if (update.my_chat_member && update.my_chat_member.chat.type === "private") {
    const status = update.my_chat_member.new_chat_member.status;
    const blocked = status === "kicked";
    await setBlocked(ctx.db, update.my_chat_member.from.id, blocked);
    if (blocked) await recordAnalytics(ctx.db, "bot_blocked", ctx.now.toISOString(), { props: { tg: true } });
  }
}

async function handleMessage(message: TgMessage, ctx: BotContext): Promise<void> {
  const from = message.from;
  if (!from || from.is_bot || message.chat.type !== "private") return;
  const now = ctx.now.toISOString();
  const text = message.text ?? "";
  const isAdmin = ctx.admins.has(from.id);
  const start = parseStart(text);

  if (start.isStart) {
    const funnel = start.payload ? await findActiveFunnel(ctx.db, start.payload) : null;
    const { user, isNew } = await upsertUser(
      ctx.db,
      from,
      now,
      start.payload ? { code: start.payload, funnelId: funnel?.id ?? null } : null,
    );
    if (funnel && !isNew) await touchLeadFunnel(ctx.db, user.id, funnel.id, now);
    await recordFunnelEvent(
      ctx.db,
      {
        userId: user.id,
        type: "START",
        funnelId: funnel?.id ?? null,
        payload: { code: start.payload, known: Boolean(funnel), is_new_user: isNew },
      },
      now,
    );
    // The admin without a campaign gets the panel; with a campaign link they see exactly what a client sees.
    if (isAdmin && !start.payload) return sendAdminMenu(ctx.tg, message.chat.id);
    if (funnel && (await deliverLeadMagnet(ctx, message.chat.id, user, funnel))) return;
    const reply = start.payload ? "unknownCampaign" : "welcome";
    await sendMessage(ctx.tg, message.chat.id, await template(ctx.db, reply));
    return;
  }

  await upsertUser(ctx.db, from, now, null);
  if (isAdmin && message.document && isResearchFile(message)) return handleResearchUpload(ctx.tg, ctx.db, message, ctx.now);
  if (isAdmin && message.document) return handleAdminUpload(ctx.tg, ctx.db, ctx.files, message, ctx.now);
  if (isAdmin && /^\/admin(?:@\w+)?\s*$/.test(text.trim())) return sendAdminMenu(ctx.tg, message.chat.id);
  await sendMessage(ctx.tg, message.chat.id, await template(ctx.db, "fallback"));
}

async function handleCallback(callback: TgCallbackQuery, ctx: BotContext): Promise<void> {
  const data = callback.data ?? "";
  const message = callback.message;
  const isAdminAction = [ADMIN_CALLBACK_PREFIX, MAGNET_CALLBACK_PREFIX, RESEARCH_CALLBACK_PREFIX].some((p) => data.startsWith(p));
  if (isAdminAction) {
    // Hidden buttons are not a security boundary: every admin action is re-checked here.
    if (!ctx.admins.has(callback.from.id) || !message) {
      await ctx.tg.call("answerCallbackQuery", { callback_query_id: callback.id });
      return;
    }
    const target = {
      id: callback.id,
      fromId: callback.from.id,
      chatId: message.chat.id,
      messageId: message.message_id,
      data,
    };
    if (data.startsWith(MAGNET_CALLBACK_PREFIX)) return handleMagnetCallback(ctx.tg, ctx.db, target, ctx.now);
    if (data.startsWith(RESEARCH_CALLBACK_PREFIX)) return handleResearchCallback(ctx.tg, ctx.db, target, ctx.now);
    return handleAdminCallback(ctx.tg, ctx.db, target, ctx.now);
  }
  if (data.startsWith(CTA_CALLBACK_PREFIX)) {
    const { user } = await upsertUser(ctx.db, callback.from, ctx.now.toISOString(), null);
    return handleCtaClick(ctx, callback, user);
  }
  await ctx.tg.call("answerCallbackQuery", { callback_query_id: callback.id });
}
