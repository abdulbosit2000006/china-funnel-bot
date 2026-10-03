import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { localTime } from "../src/time";
import { ADMIN_ID, CLIENT_ID, callbackUpdate, fakeTelegram, makeApp, messageUpdate, postUpdate } from "./helpers";

const T0 = "2026-10-03T02:00:00.000Z"; // 07:00 in Tashkent

async function seed() {
  await env.DB.prepare(
    `INSERT INTO lead_magnets (slug, version, type, title, status, r2_key, tg_file_id, created_at, updated_at)
     VALUES ('canton', 1, 'EXHIBITION_GUIDE', 'Canton guide', 'ACTIVE', 'k', 'f', ?, ?)`,
  ).bind(T0, T0).run();
  await env.DB.prepare("INSERT INTO funnels (code, kind, lead_magnet_slug, created_at) VALUES ('canton_c1', 'EXHIBITION', 'canton', ?)").bind(T0).run();
}

const reports = (tg: ReturnType<typeof fakeTelegram>) =>
  tg.calls.filter((c) => c.method === "sendMessage" && String(c.params.text).includes("Утренний отчёт"));

describe("statistics", () => {
  it("local time follows the configured zone", () => {
    expect(localTime(new Date("2026-10-03T19:30:00Z"), "Asia/Tashkent")).toEqual({ date: "2026-10-04", hour: 0, minute: 30, weekday: 0 });
  });

  it("the morning report goes out once a day after 09:00 Tashkent with the day's funnel", async () => {
    await seed();
    const tg = fakeTelegram();
    const { app } = makeApp(tg, new Date(T0));
    await postUpdate(app, messageUpdate(CLIENT_ID, "/start canton_c1"));
    await app.scheduled({ scheduledTime: Date.parse("2026-10-03T03:30:00Z") }, env); // 08:30
    expect(reports(tg)).toHaveLength(0);
    await app.scheduled({ scheduledTime: Date.parse("2026-10-03T04:00:00Z") }, env); // 09:00
    await app.scheduled({ scheduledTime: Date.parse("2026-10-03T04:01:00Z") }, env);
    const sent = reports(tg);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params.chat_id).toBe(ADMIN_ID);
    expect(String(sent[0]!.params.text)).toContain("Входы в бота: <b>1</b>");
    expect(String(sent[0]!.params.text)).toContain("PDF выдано: <b>1</b>");
    expect(String(sent[0]!.params.text)).toContain("Canton guide");
    await app.scheduled({ scheduledTime: Date.parse("2026-10-04T04:00:00Z") }, env); // next morning
    expect(reports(tg)).toHaveLength(2);
  });

  it("Statistics and Leads panels show the funnel by post and by topic", async () => {
    await seed();
    const tg = fakeTelegram();
    const { app } = makeApp(tg, new Date(T0));
    await postUpdate(app, messageUpdate(CLIENT_ID, "/start canton_c1"));
    const magnet = await env.DB.prepare("SELECT id FROM lead_magnets").first<{ id: number }>();
    const funnel = await env.DB.prepare("SELECT id FROM funnels").first<{ id: number }>();
    await postUpdate(app, callbackUpdate(CLIENT_ID, `cta:${magnet!.id}:${funnel!.id}`));
    tg.calls.length = 0;
    await postUpdate(app, callbackUpdate(ADMIN_ID, "adm:stats"));
    await postUpdate(app, callbackUpdate(ADMIN_ID, "adm:leads"));
    const [stats, leads] = tg.calls.filter((c) => c.method === "editMessageText").map((c) => String(c.params.text));
    expect(stats).toContain("Canton guide: входы 1, PDF 1, интерес 1");
    expect(stats).toContain("Выставки: PDF 1, интерес 1 (100%)");
    expect(leads).toContain("интерес: 1");
    expect(leads).toContain("User2000");
  });
});
