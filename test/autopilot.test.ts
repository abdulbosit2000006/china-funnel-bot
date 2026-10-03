import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import exhibition from "./fixtures/exhibition-research.json";
import manufacturing from "./fixtures/manufacturing-research.json";
import { ADMIN_ID, aiAnswer, callbackUpdate, fakeAi, fakeImageRenderer, fakeRenderer, fakeTelegram, makeApp, postUpdate } from "./helpers";
import type { TgUpdate } from "../src/telegram/types";

const CHANNEL_ID = -1009876543210;
let nextId = 900_000;

const at = (iso: string) => ({ scheduledTime: Date.parse(iso) });
const candidates = (name: string) => JSON.stringify({
  candidates: [{ name, edition: "2027", full_name: name, city: "Guangzhou", dates: "aprel 2027", industry: "sanoat", official_site: "https://www.cantonfair.org.cn", why: "x", source_url: "https://www.cantonfair.org.cn/en" }],
});
const channelAdmin = (): TgUpdate => ({
  update_id: nextId++,
  my_chat_member: {
    chat: { id: CHANNEL_ID, type: "channel", title: "Kanal" },
    from: { id: ADMIN_ID, is_bot: false, first_name: "Owner" },
    new_chat_member: { status: "administrator", user: { id: 42, is_bot: true, first_name: "bot" } },
  },
});
const jsonUpload = (fileId: string): TgUpdate => {
  const id = nextId++;
  return {
    update_id: id,
    message: {
      message_id: id, from: { id: ADMIN_ID, is_bot: false, first_name: "Admin" }, chat: { id: ADMIN_ID, type: "private" }, date: 0,
      document: { file_id: fileId, file_unique_id: `u-${fileId}`, file_name: "r.json", mime_type: "application/json", file_size: 5000 },
    },
  };
};

describe("autopilot", () => {
  it("Monday: researches at night, delivers PDF + post at 09:00, one tap publishes both", async () => {
    const tg = fakeTelegram();
    const ai = fakeAi();
    const renderPdf = fakeRenderer();
    const { app } = makeApp(tg, new Date("2026-10-04T20:00:00Z"), renderPdf, fakeImageRenderer(), undefined, ai);
    await postUpdate(app, channelAdmin());

    await app.scheduled(at("2026-10-04T19:30:00Z"), env); // Mon 00:30 Tashkent: too early
    expect(ai.created).toHaveLength(0);
    await app.scheduled(at("2026-10-04T20:00:00Z"), env); // Mon 01:00: discovery queued and started
    expect(ai.created).toHaveLength(1);
    expect(await env.DB.prepare("SELECT kind, subject, auto_date FROM ai_runs").first()).toEqual({ kind: "DISCOVER", subject: "EXHIBITION", auto_date: "2026-10-05" });
    await app.scheduled(at("2026-10-04T20:01:00Z"), env);
    expect(ai.created).toHaveLength(1); // not started twice

    ai.answers.resp_1 = aiAnswer("resp_1", candidates("Canton Fair"), ["https://cantonfair.org.cn/en"]);
    await app.scheduled(at("2026-10-04T20:02:00Z"), env); // discovery done → research queued
    await app.scheduled(at("2026-10-04T20:03:00Z"), env); // research started
    expect(JSON.stringify(ai.created[1]!.input)).toContain("Canton Fair");
    ai.answers.resp_2 = aiAnswer("resp_2", JSON.stringify(exhibition), exhibition.sources.map((s) => s.url));
    tg.calls.length = 0;
    await app.scheduled(at("2026-10-04T20:04:00Z"), env); // package stored (quietly) and rendered
    await app.scheduled(at("2026-10-04T20:05:00Z"), env);
    const item = await env.DB.prepare("SELECT status, auto_date, pdf_r2_key, pdf_tg_file_id FROM research_items").first<Record<string, string | null>>();
    expect(item).toMatchObject({ status: "IN_REVIEW", auto_date: "2026-10-05", pdf_tg_file_id: null });
    expect(item!.pdf_r2_key).toBeTruthy();
    expect(renderPdf.rendered).toHaveLength(1);
    expect(tg.calls.filter((c) => c.params.chat_id === ADMIN_ID || c.params.chat_id === String(ADMIN_ID))).toHaveLength(0); // nothing at night

    await app.scheduled(at("2026-10-05T03:00:00Z"), env); // 08:00: still waiting
    expect(tg.calls.some((c) => c.method === "sendDocument")).toBe(false);
    await app.scheduled(at("2026-10-05T04:00:00Z"), env); // 09:00: PDF delivered
    const pdf = tg.calls.find((c) => c.method === "sendDocument")!;
    expect(pdf.params.chat_id).toBe(String(ADMIN_ID));
    expect(String(pdf.params.caption)).toContain("Все источники взяты из результатов поиска");
    expect(tg.calls.some((c) => String(c.params.text ?? "").includes("Пост на сегодня"))).toBe(true);
    const magnet = await env.DB.prepare("SELECT id, status, type FROM lead_magnets").first<{ id: number; status: string; type: string }>();
    expect(magnet).toMatchObject({ status: "DRAFT", type: "EXHIBITION_GUIDE" });

    await app.scheduled(at("2026-10-05T04:01:00Z"), env); // post preview
    const preview = tg.calls.filter((c) => c.method === "sendPhoto").at(-1)!;
    const post = await env.DB.prepare("SELECT id, status FROM content_items").first<{ id: number; status: string }>();
    expect(post!.status).toBe("PREVIEW");
    expect(String(preview.params.reply_markup)).toContain("💰 Safar narxini bilish");

    await postUpdate(app, callbackUpdate(ADMIN_ID, `pp:p:${post!.id}`));
    expect((await env.DB.prepare("SELECT status FROM lead_magnets").first())).toEqual({ status: "ACTIVE" });
    expect((await env.DB.prepare("SELECT status FROM research_items").first())).toEqual({ status: "ACTIVE" });
    expect(tg.calls.filter((c) => c.params.chat_id === CHANNEL_ID)).toHaveLength(1);

    await app.scheduled(at("2026-10-05T05:00:00Z"), env); // delivered once only
    expect(tg.calls.filter((c) => c.method === "sendDocument")).toHaveLength(1);
  });

  it("Wednesday has no slot, and /autopilot off stops it", async () => {
    const tg = fakeTelegram();
    const ai = fakeAi();
    const { app } = makeApp(tg, new Date("2026-10-06T20:00:00Z"), undefined, undefined, undefined, ai);
    await app.scheduled(at("2026-10-06T20:00:00Z"), env); // Wed 01:00: no slot
    expect(ai.created).toHaveLength(0);

    await postUpdate(app, { update_id: nextId++, message: { message_id: 1, from: { id: ADMIN_ID, is_bot: false, first_name: "A" }, chat: { id: ADMIN_ID, type: "private" }, date: 0, text: "/autopilot off" } });
    expect(String(tg.calls.at(-1)!.params.text)).toContain("Автопилот выключен");
    await app.scheduled(at("2026-10-07T20:00:00Z"), env); // Thu 01:00: planned, but switched off
    expect(ai.created).toHaveLength(0);
  });
});

describe("business model funnel", () => {
  it("a manufacturing package becomes a business-model PDF and a post without numbers, with its own button", async () => {
    const tg = fakeTelegram({ "documents/m.json": JSON.stringify(manufacturing) });
    const renderPdf = fakeRenderer();
    const { app } = makeApp(tg, new Date("2026-10-03T12:00:00Z"), renderPdf);
    await postUpdate(app, jsonUpload("m"));
    expect(String(tg.calls.at(-1)!.params.text)).toContain("CAPEX");
    await app.scheduled(at("2026-10-03T12:01:00Z"), env);
    const item = await env.DB.prepare("SELECT id, kind, status FROM research_items").first<{ id: number; kind: string; status: string }>();
    expect(item).toMatchObject({ kind: "MANUFACTURING", status: "IN_REVIEW" });
    expect(renderPdf.rendered[0]!.html).toContain("NAMUNA");

    await postUpdate(app, callbackUpdate(ADMIN_ID, `rp:a:${item!.id}`));
    expect(await env.DB.prepare("SELECT type, status FROM lead_magnets").first()).toEqual({ type: "MANUFACTURING_MODEL", status: "ACTIVE" });
    expect(await env.DB.prepare("SELECT kind FROM funnels").first()).toEqual({ kind: "MANUFACTURING" });
    await app.scheduled(at("2026-10-03T12:02:00Z"), env);
    const post = await env.DB.prepare("SELECT text FROM content_items").first<{ text: string }>();
    expect(post!.text).toContain("Qancha investitsiya kerak");
    expect(post!.text).toContain(manufacturing.product.name);
    expect(post!.text).not.toMatch(/\$\s?\d/);
    const preview = tg.calls.filter((c) => c.method === "sendPhoto").at(-1)!;
    expect(String(preview.params.reply_markup)).toContain("📊 Biznes hisob-kitobini olish");
  });
});

describe("autopilot limits", () => {
  it("a refused start (daily AI limit) is tried once a day, not every minute", async () => {
    const tg = fakeTelegram();
    const ai = fakeAi();
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ai.daily_limit', '0')").run();
    const { app } = makeApp(tg, new Date("2026-10-04T20:00:00Z"), undefined, undefined, undefined, ai);
    await app.scheduled(at("2026-10-04T20:00:00Z"), env);
    await app.scheduled(at("2026-10-04T20:01:00Z"), env);
    await app.scheduled(at("2026-10-04T20:02:00Z"), env);
    expect(tg.calls.filter((c) => String(c.params.text ?? "").includes("Дневной лимит"))).toHaveLength(1);
  });
});
