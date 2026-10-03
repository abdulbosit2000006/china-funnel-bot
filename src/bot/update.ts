import {
  findActiveFunnel,
  recordAnalytics,
  recordFunnelEvent,
  setBlocked,
  touchLeadFunnel,
  upsertUser,
} from "../db";
import { sendMessage, type Telegram } from "../telegram/api";
import type { TgCallbackQuery, TgMessage, TgUpdate } from "../telegram/types";
import { ADMIN_CALLBACK_PREFIX, handleAdminCallback, sendAdminMenu } from "./admin";
import { clientTexts } from "./texts";

export interface BotContext {
  db: D1Database;
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
    if (isAdmin) return sendAdminMenu(ctx.tg, message.chat.id);
    // Phase 2: a known campaign delivers its lead magnet PDF here.
    const reply = start.payload && !funnel ? clientTexts.unknownCampaign : clientTexts.welcome;
    await sendMessage(ctx.tg, message.chat.id, reply);
    return;
  }

  await upsertUser(ctx.db, from, now, null);
  if (isAdmin && /^\/admin(?:@\w+)?\s*$/.test(text.trim())) return sendAdminMenu(ctx.tg, message.chat.id);
  await sendMessage(ctx.tg, message.chat.id, clientTexts.fallback);
}

async function handleCallback(callback: TgCallbackQuery, ctx: BotContext): Promise<void> {
  const data = callback.data ?? "";
  const message = callback.message;
  if (data.startsWith(ADMIN_CALLBACK_PREFIX)) {
    // Hidden buttons are not a security boundary: every admin action is re-checked here.
    if (!ctx.admins.has(callback.from.id) || !message) {
      await ctx.tg.call("answerCallbackQuery", { callback_query_id: callback.id });
      return;
    }
    await handleAdminCallback(
      ctx.tg,
      ctx.db,
      { id: callback.id, fromId: callback.from.id, chatId: message.chat.id, messageId: message.message_id, data },
      ctx.now,
    );
    return;
  }
  await ctx.tg.call("answerCallbackQuery", { callback_query_id: callback.id });
}
