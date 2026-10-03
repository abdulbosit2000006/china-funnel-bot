import { runAiTick } from "./bot/ai";
import { AUTOPILOT_JOB, runAutopilot, runAutopilotDelivery } from "./bot/autopilot";
import { runFollowups } from "./bot/leads";
import { runDailyReport, runMonthlyReport } from "./bot/stats";
import { CONTENT_HANDLERS } from "./bot/content";
import { runContentPlanner } from "./bot/plan";
import { POST_CARD_JOB, postPreviewWithoutPhoto, runPostCardJob } from "./bot/posts";
import { createOpenAI, type AiClient } from "./ai/openai";
import { RENDER_JOB, runRenderJob } from "./bot/research";
import { claimUpdate, deleteOldUpdates, putSetting } from "./db";
import { claimJob, failJob, finishJob } from "./jobs";
import { handleUpdate } from "./bot/update";
import { parseAdminIds, type Env } from "./env";
import { log } from "./log";
import { createBrowserImageRenderer, createBrowserRenderer, type ImageRenderer, type PdfRenderer } from "./pdf/render";
import { createTelegram, type Telegram } from "./telegram/api";
import type { TgUpdate } from "./telegram/types";

export const WEBHOOK_PATH = "/tg/webhook";
const ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member"];

export interface AppDeps {
  telegram: (env: Env) => Telegram;
  renderPdf: (env: Env) => PdfRenderer;
  renderImage: (env: Env) => ImageRenderer;
  now: () => Date;
  /** Outbound HTTP for official posters; tests replace it. */
  fetchUrl?: typeof fetch;
  /** AI provider; null when no key is configured. */
  ai?: (env: Env) => AiClient | null;
}

export const DEFAULT_AI_MODEL = "gpt-6.1-sol";
const defaultAi = (env: Env): AiClient | null =>
  env.OPENAI_API_KEY ? createOpenAI(env.OPENAI_API_KEY, env.OPENAI_MODEL || DEFAULT_AI_MODEL, fetch, env.OPENAI_TRANSCRIBE_MODEL || undefined) : null;

const defaultDeps: AppDeps = {
  telegram: (env) => createTelegram(env.TELEGRAM_BOT_TOKEN),
  renderPdf: (env) => createBrowserRenderer(env.BROWSER),
  renderImage: (env) => createBrowserImageRenderer(env.BROWSER),
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
        ai: (deps.ai ?? defaultAi)(env),
        admins: parseAdminIds(env.ADMIN_TG_IDS),
        timeZone: env.TIMEZONE || "Asia/Tashkent",
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
          { command: "find", description: "AI: найти выставки (можно с темой)" },
          { command: "research", description: "AI: research по выставке" },
          { command: "ideas", description: "AI: найти бизнес-идеи (можно с темой)" },
          { command: "business", description: "AI: бизнес-модель по названию" },
          { command: "week", description: "План этой недели" },
          { command: "plan", description: "План следующей недели" },
          { command: "case", description: "Новый кейс (текст, голосовые, фото)" },
          { command: "cases", description: "База кейсов" },
          { command: "breaking", description: "Срочный пост по новости" },
          { command: "expo", description: "Мои выставки" },
          { command: "season", description: "Сезон выставок: on/off" },
          { command: "views", description: "Внести просмотры постов" },
          { command: "budget", description: "Расход и лимит OpenAI" },
          { command: "autopilot", description: "Автопилот: статус и запуск" },
        ],
      });
    }
    const me = await tg.call<{ username: string }>("getMe", {});
    await putSetting(env.DB, "bot.username", me.username);
    log.info("setup.done", { url, admins: admins.length });
    return Response.json({ ok: true, webhook: url, bot: me.username, admins: admins.length });
  }

  /** One job per tick: the Free plan allows 2 new browsers per minute, and a render takes a while. */
  async function runJobs(env: Env, now: Date): Promise<void> {
    const job = await claimJob(env.DB, now);
    if (!job) return;
    const tg = deps.telegram(env);
    const payload = JSON.parse(job.payload) as { researchId: number; contentId: number; chatId: number };
    try {
      if (job.kind === RENDER_JOB) {
        await runRenderJob({ tg, db: env.DB, files: env.FILES, renderPdf: deps.renderPdf(env), now, fetchUrl: deps.fetchUrl ?? fetch }, payload);
      } else if (job.kind === AUTOPILOT_JOB) {
        await runAutopilotDelivery({ tg, db: env.DB, files: env.FILES, now }, payload);
      } else if (job.kind === POST_CARD_JOB) {
        await runPostCardJob({ tg, db: env.DB, files: env.FILES, renderImage: deps.renderImage(env), fetchUrl: deps.fetchUrl ?? fetch }, payload);
      }
      await finishJob(env.DB, job.id);
      log.info("job.done", { id: job.id, kind: job.kind, attempts: job.attempts });
    } catch (error) {
      log.error("job.failed", error, { id: job.id, kind: job.kind, attempts: job.attempts });
      const gaveUp = await failJob(env.DB, job, error, now);
      if (gaveUp && job.kind === POST_CARD_JOB) {
        await postPreviewWithoutPhoto(tg, env.DB, payload).catch((e) => log.error("post.fallback_failed", e));
      } else if (gaveUp) {
        await tg
          .call("sendMessage", { chat_id: payload.chatId, text: `⚠️ Не удалось ${job.kind === AUTOPILOT_JOB ? "доставить пост автопилота" : "создать PDF"} после ${job.attempts} попыток. Ошибка записана в логи.` })
          .catch(() => undefined);
      }
    }
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
      const ai = (deps.ai ?? defaultAi)(env);
      const admins = parseAdminIds(env.ADMIN_TG_IDS);
      const timeZone = env.TIMEZONE || "Asia/Tashkent";
      await runFollowups({ db: env.DB, tg: deps.telegram(env), now }).catch((e) => log.error("followups.failed", e));
      await runDailyReport({ db: env.DB, tg: deps.telegram(env), admins, now, timeZone })
        .catch((e) => log.error("report.failed", e));
      await runMonthlyReport({ db: env.DB, tg: deps.telegram(env), admins, now, timeZone }).catch((e) => log.error("report.monthly_failed", e));
      await runContentPlanner({ db: env.DB, tg: deps.telegram(env), ai, admins, now, timeZone }).catch((e) => log.error("planner.failed", e));
      await runAutopilot({ db: env.DB, tg: deps.telegram(env), ai, admins, now, timeZone }).catch((e) => log.error("autopilot.failed", e));
      await runAiTick({ tg: deps.telegram(env), db: env.DB, ai, admins, timeZone, handlers: CONTENT_HANDLERS }, now).catch((e) => log.error("ai.tick_failed", e));
      await runJobs(env, now);
      if (now.getUTCMinutes() === 0) {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
        const removed = await deleteOldUpdates(env.DB, weekAgo);
        log.info("cron.cleanup", { removed });
      }
    },
  };
}
