import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseStart } from "../src/bot/update";
import { ADMIN_ID, CLIENT_ID, callbackUpdate, makeApp, messageUpdate, postUpdate } from "./helpers";

const count = async (sql: string, ...args: unknown[]) =>
  (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0;

describe("webhook security", () => {
  it("rejects a wrong secret token and does nothing", async () => {
    const { app, tg } = makeApp();
    const res = await postUpdate(app, messageUpdate(CLIENT_ID, "/start"), "wrong");
    expect(res.status).toBe(403);
    expect(tg.calls).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM users")).toBe(0);
  });

  it("rejects malformed bodies", async () => {
    const { app } = makeApp();
    const res = await app.fetch(
      new Request("https://x/tg/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
        body: "{not json",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("processes a redelivered update only once", async () => {
    const { app, tg } = makeApp();
    const update = messageUpdate(CLIENT_ID, "/start");
    expect((await postUpdate(app, update)).status).toBe(200);
    const second = await postUpdate(app, update);
    expect(await second.json()).toEqual({ ok: true, duplicate: true });
    expect(tg.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM funnel_events")).toBe(1);
  });

  it("answers 200 even when handling fails, so Telegram does not retry forever", async () => {
    const tg = {
      calls: [],
      async call(): Promise<never> {
        throw new Error("telegram down");
      },
    };
    const { app } = makeApp(tg as never);
    const res = await postUpdate(app, messageUpdate(CLIENT_ID, "/start"));
    expect(res.status).toBe(200);
  });
});

describe("/start and campaigns", () => {
  it("parses deep-link payloads by Telegram rules", () => {
    expect(parseStart("/start")).toEqual({ isStart: true, payload: null });
    expect(parseStart("/start cf27_p1")).toEqual({ isStart: true, payload: "cf27_p1" });
    expect(parseStart("/start bad$payload")).toEqual({ isStart: true, payload: null });
    expect(parseStart("/start " + "a".repeat(65))).toEqual({ isStart: true, payload: null });
    expect(parseStart("hello")).toEqual({ isStart: false, payload: null });
  });

  it("creates one user and one VISITOR lead, and records each start with its campaign", async () => {
    await env.DB.prepare("INSERT INTO funnels (code, kind, created_at) VALUES ('cf27_p1', 'EXHIBITION', '2026-10-01')").run();
    const funnelId = (await env.DB.prepare("SELECT id FROM funnels WHERE code='cf27_p1'").first<{ id: number }>())!.id;
    const { app, tg } = makeApp();

    await postUpdate(app, messageUpdate(CLIENT_ID, "/start cf27_p1"));
    await postUpdate(app, messageUpdate(CLIENT_ID, "/start other_code"));

    expect(await count("SELECT COUNT(*) AS n FROM users WHERE tg_user_id = ?", CLIENT_ID)).toBe(1);
    const user = await env.DB.prepare("SELECT * FROM users WHERE tg_user_id = ?").bind(CLIENT_ID)
      .first<{ id: number; first_source: string; first_funnel_id: number }>();
    expect(user?.first_source).toBe("cf27_p1");
    expect(user?.first_funnel_id).toBe(funnelId);
    expect(await count("SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND stage = 'VISITOR'", user!.id)).toBe(1);

    const events = await env.DB.prepare("SELECT funnel_id, payload FROM funnel_events WHERE user_id = ? ORDER BY id")
      .bind(user!.id).all<{ funnel_id: number | null; payload: string }>();
    expect(events.results.map((e) => e.funnel_id)).toEqual([funnelId, null]);
    expect(JSON.parse(events.results[1]!.payload)).toMatchObject({ code: "other_code", known: false });

    const texts = tg.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.params.text));
    expect(texts[1]).toContain("mavjud emas");
  });
});

describe("admin mode", () => {
  it("never shows the admin menu to clients", async () => {
    const { app, tg } = makeApp();
    await postUpdate(app, messageUpdate(CLIENT_ID, "/admin"));
    const sent = tg.calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.params)).not.toContain("adm:");
  });

  it("shows the admin menu to the owner on /start and /admin", async () => {
    const { app, tg } = makeApp();
    await postUpdate(app, messageUpdate(ADMIN_ID, "/start"));
    await postUpdate(app, messageUpdate(ADMIN_ID, "/admin"));
    const sent = tg.calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(2);
    for (const call of sent) expect(JSON.stringify(call.params.reply_markup)).toContain("adm:dashboard");
  });

  it("ignores admin buttons pressed by a non-admin", async () => {
    const { app, tg } = makeApp();
    await postUpdate(app, callbackUpdate(CLIENT_ID, "adm:dashboard"));
    expect(tg.calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
    expect(await count("SELECT COUNT(*) AS n FROM admin_actions")).toBe(0);
  });

  it("renders the dashboard with real counts and logs the action", async () => {
    const { app, tg } = makeApp();
    await postUpdate(app, messageUpdate(CLIENT_ID, "/start"));
    await postUpdate(app, callbackUpdate(ADMIN_ID, "adm:dashboard"));
    const edit = tg.calls.find((c) => c.method === "editMessageText");
    expect(String(edit?.params.text)).toContain("Пользователей всего: <b>1</b>");
    expect(String(edit?.params.text)).toContain("VISITOR: 1");
    expect(await count("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'open_section'")).toBe(1);
  });
});

describe("blocking and setup", () => {
  it("marks a user who blocked the bot", async () => {
    const { app } = makeApp();
    await postUpdate(app, messageUpdate(CLIENT_ID, "/start"));
    await postUpdate(app, {
      update_id: 999_001,
      my_chat_member: {
        chat: { id: CLIENT_ID, type: "private" },
        from: { id: CLIENT_ID, is_bot: false, first_name: "U" },
        new_chat_member: { status: "kicked", user: { id: 1, is_bot: true, first_name: "bot" } },
      },
    });
    expect(await count("SELECT is_blocked_bot AS n FROM users WHERE tg_user_id = ?", CLIENT_ID)).toBe(1);
  });

  it("requires the admin API token for setup and registers webhook + scoped commands", async () => {
    const { app, tg } = makeApp();
    const denied = await app.fetch(new Request("https://bot.example.workers.dev/admin/setup", { method: "POST" }), env);
    expect(denied.status).toBe(403);
    expect(tg.calls).toHaveLength(0);

    const ok = await app.fetch(
      new Request("https://bot.example.workers.dev/admin/setup", {
        method: "POST",
        headers: { authorization: "Bearer test-admin-api-token" },
      }),
      env,
    );
    expect(ok.status).toBe(200);
    const webhook = tg.calls.find((c) => c.method === "setWebhook");
    expect(webhook?.params).toMatchObject({
      url: "https://bot.example.workers.dev/tg/webhook",
      secret_token: "test-webhook-secret",
    });
    const scoped = tg.calls.filter((c) => c.method === "setMyCommands" && c.params.scope);
    expect(scoped).toHaveLength(1);
    expect(JSON.stringify(scoped[0]!.params)).toContain('"chat_id":1000');
  });

  it("health checks the database", async () => {
    const { app } = makeApp();
    const res = await app.fetch(new Request("https://x/health"), env);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
