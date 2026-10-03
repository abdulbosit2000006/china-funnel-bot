import { claimUpdate, deleteOldUpdates, putSetting } from "./db";
import { handleUpdate } from "./bot/update";
import { parseAdminIds, type Env } from "./env";
import { log } from "./log";
import { createTelegram, type Telegram } from "./telegram/api";
import type { TgUpdate } from "./telegram/types";

export const WEBHOOK_PATH = "/tg/webhook";
const ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member"];

export interface AppDeps {
  telegram: (env: Env) => Telegram;
  now: () => Date;
}

const defaultDeps: AppDeps = {
  telegram: (env) => createTelegram(env.TELEGRAM_BOT_TOKEN),
  now: () => new Date(),
};

/** Constant-time comparison; different lengths are compared via their digests. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

async function isAuthorizedAdminApi(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  if (!env.ADMIN_API_TOKEN || !header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice("Bearer ".length), env.ADMIN_API_TOKEN);
}

export function createApp(deps: AppDeps = defaultDeps) {
  async function webhook(request: Request, env: Env): Promise<Response> {
    const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!env.TELEGRAM_WEBHOOK_SECRET || !(await safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))) {
      return new Response("forbidden", { status: 403 });
    }
    let update: TgUpdate;
    try {
      update = (await request.json()) as TgUpdate;
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (typeof update?.update_id !== "number") return new Response("bad request", { status: 400 });

    const now = deps.now();
    try {
      if (!(await claimUpdate(env.DB, update.update_id, now.toISOString()))) {
        return Response.json({ ok: true, duplicate: true });
      }
      await handleUpdate(update, {
        db: env.DB,
        files: env.FILES,
        tg: deps.telegram(env),
        admins: parseAdminIds(env.ADMIN_TG_IDS),
        now,
      });
    } catch (error) {
      // Answer 200 anyway: a non-2xx makes Telegram redeliver the same update again and again.
      log.error("update.failed", error, { update_id: update.update_id });
    }
    return Response.json({ ok: true });
  }

  /** One-time setup: registers the webhook and the per-scope command lists. */
  async function setup(request: Request, env: Env): Promise<Response> {
    if (!(await isAuthorizedAdminApi(request, env))) return new Response("forbidden", { status: 403 });
    const tg = deps.telegram(env);
    const url = new URL(WEBHOOK_PATH, request.url).toString();
    await tg.call("setWebhook", {
      url,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ALLOWED_UPDATES,
      max_connections: 10,
    });
    await tg.call("setMyCommands", { commands: [{ command: "start", description: "Boshlash" }] });
    const admins = [...parseAdminIds(env.ADMIN_TG_IDS)];
    for (const chatId of admins) {
      await tg.call("setMyCommands", {
        scope: { type: "chat", chat_id: chatId },
        commands: [
          { command: "start", description: "Старт" },
          { command: "admin", description: "Админ-панель" },
        ],
      });
    }
    const me = await tg.call<{ username: string }>("getMe", {});
    await putSetting(env.DB, "bot.username", me.username);
    log.info("setup.done", { url, admins: admins.length });
    return Response.json({ ok: true, webhook: url, bot: me.username, admins: admins.length });
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (request.method === "POST" && pathname === WEBHOOK_PATH) return webhook(request, env);
      if (request.method === "POST" && pathname === "/admin/setup") return setup(request, env);
      if (request.method === "GET" && pathname === "/health") {
        await env.DB.prepare("SELECT 1").first();
        return Response.json({ status: "ok" });
      }
      return new Response("not found", { status: 404 });
    },

    async scheduled(controller: { scheduledTime: number }, env: Env): Promise<void> {
      const now = new Date(controller.scheduledTime);
      // Phase 3 adds follow-up delivery here (every minute).
      if (now.getUTCMinutes() === 0) {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
        const removed = await deleteOldUpdates(env.DB, weekAgo);
        log.info("cron.cleanup", { removed });
      }
    },
  };
}
