// Content System V1: weekly plan, Monday machine choice, text posts, cases, exhibitions, views, budget, monthly report.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN_ID, CLIENT_ID, aiAnswer, callbackUpdate, fakeAi, fakeTelegram, makeApp, messageUpdate, postUpdate } from "./helpers";
import type { TgUpdate } from "../src/telegram/types";

const CHANNEL_ID = -1009876543210;
let nextId = 700_000;
const at = (iso: string) => ({ scheduledTime: Date.parse(iso) });
const texts = (tg: ReturnType<typeof fakeTelegram>) => tg.calls.map((c) => String(c.params.text ?? c.params.caption ?? ""));
const full = { relevance: 20, value: 20, evidence: 15, specificity: 10, novelty: 10, actionability: 10, lead_potential: 10, freshness: 5 };
const weak = { relevance: 10, value: 10, evidence: 5, specificity: 5, novelty: 5, actionability: 5, lead_potential: 5, freshness: 2 };

const cand = (topic: string, format: string, url: string, scores = full, extra: Record<string, unknown> = {}) => ({
  topic, format, goal: "LEAD_GENERATION", benefit: "Foyda", hook: "Hook", angle: "почему сейчас", scores, source_urls: [url], ...extra,
});

const channelAdmin = (): TgUpdate => ({
  update_id: nextId++,
  my_chat_member: {
    chat: { id: CHANNEL_ID, type: "channel", title: "Kanal" },
    from: { id: ADMIN_ID, is_bot: false, first_name: "Owner" },
    new_chat_member: { status: "administrator", user: { id: 42, is_bot: true, first_name: "bot" } },
  },
});

const voiceUpdate = (fileId: string, duration: number): TgUpdate => {
  const id = nextId++;
  return {
    update_id: id,
    message: {
      message_id: id, from: { id: ADMIN_ID, is_bot: false, first_name: "Admin" }, chat: { id: ADMIN_ID, type: "private" }, date: 0,
      voice: { file_id: fileId, file_unique_id: `u-${fileId}`, duration, mime_type: "audio/ogg" },
    },
  };
};

const trustDraft = {
  text:
    "<b>Xitoylik zavod bilan birinchi uchrashuvda 3 ta xato</b>\n\nKo'p tadbirkorlar birinchi uchrashuvda darhol narx so'raydi. Zavod esa sizni jiddiy xaridor deb bilmaguncha eng yaxshi narxni bermaydi.\n\n" +
    "Avval hajm, sifat talablari va yetkazib berish shartlarini aniq ayting. Keyin namunani so'rang va faqat shundan so'ng narx haqida gaplashing.\n\nSavollaringiz bo'lsa, botga yozing.",
  format: "XATO",
  goal: "TRUST",
  cta_type: "BOT_QUESTION",
  topic: "Ошибки на первой встрече с заводом",
  claims: [],
  poll: null,
};

async function seedSlot(rubric: string, date: string, candidates: unknown[]): Promise<number> {
  const plan = await env.DB.prepare("INSERT INTO content_plans (week_start, status, mode, chat_id, created_at) VALUES ('2026-10-05', 'APPROVED', 'NORMAL', ?, '2026-10-03T07:00:00Z') RETURNING id")
    .bind(ADMIN_ID)
    .first<{ id: number }>();
  const slot = await env.DB.prepare("INSERT INTO plan_slots (plan_id, slot_date, rubric, candidates, chosen, created_at, updated_at) VALUES (?, ?, ?, ?, 0, '2026-10-03T07:00:00Z', '2026-10-03T07:00:00Z') RETURNING id")
    .bind(plan!.id, date, rubric, JSON.stringify(candidates))
    .first<{ id: number }>();
  return slot!.id;
}

describe("weekly plan and the Monday machine", () => {
  it("Saturday 12:00: the plan arrives scored, exhibitions only from the founder's list; approval searches real machines; the chosen one goes into the PDF research", async () => {
    const tg = fakeTelegram();
    const ai = fakeAi();
    const { app } = makeApp(tg, new Date("2026-10-03T07:00:00Z"), undefined, undefined, undefined, ai);
    await postUpdate(app, messageUpdate(ADMIN_ID, "/expo Canton Fair, Guangzhou"));
    expect(texts(tg).at(-1)).toContain("Canton Fair, Guangzhou");

    await app.scheduled(at("2026-10-03T06:59:00Z"), env); // 11:59: not yet
    expect(ai.created).toHaveLength(0);
    await app.scheduled(at("2026-10-03T07:00:00Z"), env); // 12:00: plan queued and started
    expect(ai.created).toHaveLength(1);
    expect(JSON.stringify(ai.created[0]!.input)).toContain("Canton Fair");
    await app.scheduled(at("2026-10-03T07:01:00Z"), env);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM content_plans").first()).toEqual({ n: 1 }); // one plan per week

    const urls = ["https://example.uz/cups", "https://example.cn/trend", "https://www.cantonfair.org.cn/en"];
    ai.answers.resp_1 = aiAnswer("resp_1", JSON.stringify({
      slots: {
        BUSINESS_MODEL: [
          cand("Qog'oz stakan ishlab chiqarish", "MANUFACTURING", urls[0]!),
          cand("Penoplast bloklar", "MANUFACTURING", urls[0]!, weak),
        ],
        TRUST: [cand("Zavod bilan birinchi uchrashuv", "XATO", "https://anything.example")],
        OPPORTUNITY: [
          cand("Canton Fair 2027", "EXHIBITION", urls[2]!, full, { exhibition: "Canton Fair" }),
          cand("Hannover Messe", "EXHIBITION", urls[2]!, full, { exhibition: "Hannover Messe" }),
          cand("Xitoyda PET narxi tushdi", "TREND", urls[1]!),
        ],
      },
      exhibition_dates: [{ name: "Canton Fair", starts_on: "2027-04-15", ends_on: "2027-05-05", source_url: urls[2] }],
      similar_exhibitions: [{ name: "CIIF", city: "Shanghai", why: "sanoat" }],
    }), urls);
    await app.scheduled(at("2026-10-03T07:02:00Z"), env);
    const planMsg = tg.calls.filter((c) => c.method === "sendMessage" && String(c.params.text).includes("План на неделю")).at(-1)!;
    const planText = String(planMsg.params.text);
    expect(planText).toContain("Qog'oz stakan");
    expect(planText).not.toContain("Penoplast"); // below the threshold
    expect(planText).not.toContain("Hannover"); // not in the founder's list
    expect(planText).toContain("Canton Fair 2027");
    expect(planText).toContain("CIIF");
    expect(JSON.stringify(planMsg.params.reply_markup)).toContain("wk:a:1");
    expect(await env.DB.prepare("SELECT starts_on FROM exhibition_calendar WHERE name = 'Canton Fair'").first()).toEqual({ starts_on: "2027-04-15" });

    await postUpdate(app, callbackUpdate(ADMIN_ID, "wk:a:1"));
    expect(await env.DB.prepare("SELECT status FROM content_plans").first()).toEqual({ status: "APPROVED" });
    expect(texts(tg).at(-1)).toContain("ищу 2–3 реальные линии");
    await app.scheduled(at("2026-10-03T07:03:00Z"), env); // equipment search started
    expect(JSON.stringify(ai.created[1]!.input)).toContain("Qog'oz stakan");

    ai.answers.resp_2 = aiAnswer("resp_2", JSON.stringify({
      options: [
        { name: "ZB-12 paper cup machine", manufacturer: "Ruian Zhengbang", model: "ZB-12", page_url: "https://zb.example.cn/zb12", image_url: "https://zb.example.cn/zb12.jpg",
          price: { value: 42000, currency: "USD", basis: "FOB Ningbo", source_date: "2026-09-20", label: "MARKET DATA" }, capacity: "120 dona/min", power_kw: 7, area_m2: 30, operators: 1, specs: ["2–16 oz"] },
        { name: "No page machine" },
      ],
    }), ["https://zb.example.cn/zb12"]);
    tg.calls.length = 0;
    await app.scheduled(at("2026-10-03T07:04:00Z"), env);
    const card = tg.calls.find((c) => c.method === "sendPhoto")!;
    expect(card.params.photo).toBe("https://zb.example.cn/zb12.jpg");
    expect(String(card.params.caption)).toContain("$42 000 FOB Ningbo");
    expect(texts(tg).join("\n")).not.toContain("No page machine"); // an option without a product page is dropped
    expect(await env.DB.prepare("SELECT status FROM plan_slots WHERE rubric = 'BUSINESS_MODEL'").first()).toEqual({ status: "WAITING_EQUIPMENT" });

    const slot = await env.DB.prepare("SELECT id FROM plan_slots WHERE rubric = 'BUSINESS_MODEL'").first<{ id: number }>();
    await postUpdate(app, callbackUpdate(ADMIN_ID, `eq:o:${slot!.id}:0`));
    expect(texts(tg).at(-1)).toContain("Станок подтверждён");
    expect(await env.DB.prepare("SELECT kind, subject, auto_date, slot_id FROM ai_runs WHERE id = 3").first()).toEqual({ kind: "RESEARCH", subject: "MANUFACTURING", auto_date: "2026-10-05", slot_id: slot!.id });
    await app.scheduled(at("2026-10-03T07:05:00Z"), env);
    const prompt = JSON.stringify(ai.created[2]!.input);
    expect(prompt).toContain("владелец уже выбрал и подтвердил оборудование");
    expect(prompt).toContain("ZB-12");
  });

  it("a failed plan run can be made again with /plan", async () => {
    const tg = fakeTelegram();
    const ai = fakeAi();
    const { app } = makeApp(tg, new Date("2026-10-01T07:00:00Z"), undefined, undefined, undefined, ai);
    await postUpdate(app, messageUpdate(ADMIN_ID, "/plan"));
    expect(texts(tg).at(-1)).toContain("Готовлю план на неделю");
    await app.scheduled(at("2026-10-01T07:00:00Z"), env);
    ai.answers.resp_1 = { id: "resp_1", status: "failed", error: { message: "boom" } };
    await app.scheduled(at("2026-10-01T07:01:00Z"), env);
    expect(await env.DB.prepare("SELECT status FROM content_plans").first()).toEqual({ status: "FAILED" });
    await postUpdate(app, messageUpdate(ADMIN_ID, "/plan"));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM content_plans WHERE status = 'PLANNING'").first()).toEqual({ n: 1 });
  });
});

describe("text posts", () => {
  it("Wednesday: drafted at night, delivered at 09:00, published with a question button; a reader's question reaches the founder", async () => {
    const tg = fakeTelegram();
    const ai = fakeAi();
    const { app } = makeApp(tg, new Date("2026-10-06T20:00:00Z"), undefined, undefined, undefined, ai);
    await postUpdate(app, channelAdmin());
    const slotId = await seedSlot("TRUST", "2026-10-07", [cand("Zavod bilan birinchi uchrashuv", "XATO", "https://x.example")]);

    await app.scheduled(at("2026-10-06T20:00:00Z"), env); // Wed 01:00
    expect(ai.created).toHaveLength(1);
    expect(JSON.stringify(ai.created[0]!.input)).toContain("Zavod bilan birinchi uchrashuv");

    // First answer has a cliché: one repair round.
    ai.answers.resp_1 = aiAnswer("resp_1", JSON.stringify({ ...trustDraft, text: `${trustDraft.text} Noyob imkoniyat!` }));
    await app.scheduled(at("2026-10-06T20:01:00Z"), env);
    expect(ai.created).toHaveLength(2);
    expect(JSON.stringify(ai.created[1]!.input)).toContain("шаблонные");
    ai.answers.resp_2 = aiAnswer("resp_2", JSON.stringify(trustDraft));
    await app.scheduled(at("2026-10-06T20:02:00Z"), env);
    expect(await env.DB.prepare("SELECT status FROM plan_slots WHERE id = ?").bind(slotId).first()).toEqual({ status: "READY" });
    expect(texts(tg).join("\n")).not.toContain("Пост на сегодня"); // nothing at night

    await app.scheduled(at("2026-10-07T04:00:00Z"), env); // 09:00
    expect(texts(tg).join("\n")).toContain("Пост на сегодня");
    const preview = tg.calls.filter((c) => c.method === "sendMessage" && String(c.params.text).includes("birinchi uchrashuvda")).at(-1)!;
    expect(JSON.stringify(preview.params.reply_markup)).toContain("❓ Savol berish");
    expect(JSON.stringify(preview.params.reply_markup)).toContain("🔄 Переделать");

    const item = await env.DB.prepare("SELECT id, funnel_id, rubric, format FROM content_items").first<{ id: number; funnel_id: number; rubric: string; format: string }>();
    expect(item).toMatchObject({ rubric: "TRUST", format: "XATO" });
    await postUpdate(app, callbackUpdate(ADMIN_ID, `pp:p:${item!.id}`));
    const posted = tg.calls.find((c) => c.params.chat_id === CHANNEL_ID)!;
    expect(String(posted.params.text)).toContain("birinchi uchrashuvda");
    expect(await env.DB.prepare("SELECT status FROM plan_slots WHERE id = ?").bind(slotId).first()).toEqual({ status: "PUBLISHED" });

    const funnel = await env.DB.prepare("SELECT code FROM funnels WHERE id = ?").bind(item!.funnel_id).first<{ code: string }>();
    expect(funnel!.code).toMatch(/^q_/);
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${funnel!.code}`));
    expect(texts(tg).at(-1)).toContain("savolingizni");
    await postUpdate(app, messageUpdate(CLIENT_ID, "Namunani qanday olsa bo'ladi?"));
    expect(tg.calls.some((c) => c.params.chat_id === ADMIN_ID && String(c.params.text).includes("Namunani qanday olsa"))).toBe(true);
    const event = await env.DB.prepare("SELECT payload FROM funnel_events WHERE type = 'FOLLOWUP_REPLY'").first<{ payload: string }>();
    expect(JSON.parse(event!.payload).text).toBe("Namunani qanday olsa bo'ladi?");
  });

  it("/breaking drafts right away; a rejected post asks why", async () => {
    const tg = fakeTelegram();
    const ai = fakeAi();
    const { app } = makeApp(tg, new Date("2026-10-06T05:00:00Z"), undefined, undefined, undefined, ai);
    await postUpdate(app, messageUpdate(ADMIN_ID, "/breaking Xitoy bojxona qoidalarini o'zgartirdi"));
    await app.scheduled(at("2026-10-06T05:00:00Z"), env);
    ai.answers.resp_1 = aiAnswer("resp_1", JSON.stringify({ ...trustDraft, format: "NEWS", text: trustDraft.text.replace("3 ta xato", "muhim yangilik") }));
    await app.scheduled(at("2026-10-06T05:01:00Z"), env);
    expect(texts(tg).join("\n")).toContain("BREAKING-пост готов");
    const item = await env.DB.prepare("SELECT id, rubric FROM content_items").first<{ id: number; rubric: string }>();
    expect(item!.rubric).toBe("BREAKING");
    await postUpdate(app, callbackUpdate(ADMIN_ID, `pp:x:${item!.id}`));
    expect(texts(tg).at(-1)).toContain("Почему не подошёл");
    await postUpdate(app, callbackUpdate(ADMIN_ID, `pp:w:${item!.id}:t`));
    expect(await env.DB.prepare("SELECT reject_reason FROM content_items").first<{ reject_reason: string }>()).not.toEqual({ reject_reason: null });
  });
});

describe("cases", () => {
  it("notes and a voice note become an anonymised case; leftovers are flagged; a safe case is used on Wednesday without AI", async () => {
    const tg = fakeTelegram();
    const ai = fakeAi();
    const { app } = makeApp(tg, new Date("2026-10-05T10:00:00Z"), undefined, undefined, undefined, ai);
    await postUpdate(app, messageUpdate(ADMIN_ID, "/case"));
    expect(texts(tg).at(-1)).toContain("Кейс №1");
    await postUpdate(app, messageUpdate(ADMIN_ID, "Klient iz Tashkenta, liniya dlya stakanov"));
    await postUpdate(app, voiceUpdate("v1", 70));
    expect(ai.transcribed).toHaveLength(1);
    expect(texts(tg).at(-1)).toContain("Расшифровал");
    expect(await env.DB.prepare("SELECT kind, extra_cost_usd FROM ai_runs").first()).toEqual({ kind: "TRANSCRIBE", extra_cost_usd: 0.006 });

    await postUpdate(app, callbackUpdate(ADMIN_ID, "cs:d:1"));
    expect(texts(tg).at(-1)).toContain("Пишу пост по кейсу №1");
    await app.scheduled(at("2026-10-05T10:00:00Z"), env);
    expect(ai.created[0]).not.toHaveProperty("tools"); // the founder's own notes: no web search
    expect(JSON.stringify(ai.created[0]!.input)).toContain("Aziz aka");

    const leaked = `<b>Toshkentlik mijozimiz qanday tejadi</b>\n\n${"Mijozimiz qog'oz stakan liniyasini qidirdi. Biz uchta zavodni solishtirdik va eng ishonchlisini tanladik. ".repeat(3)}Bog'lanish: +998 90 123 45 67`;
    ai.answers.resp_1 = aiAnswer("resp_1", JSON.stringify({ text: leaked, topic: "кейс стаканы", redactions: ["имя клиента"] }));
    await app.scheduled(at("2026-10-05T10:01:00Z"), env);
    const card = texts(tg).at(-1)!;
    expect(card).toContain("Убрал: имя клиента");
    expect(card).toContain("телефон");
    expect(await env.DB.prepare("SELECT status FROM content_cases").first()).toEqual({ status: "NEEDS_REVIEW" });

    // The founder fixes the text himself, then marks it safe.
    await postUpdate(app, callbackUpdate(ADMIN_ID, "cs:e:1"));
    await postUpdate(app, messageUpdate(ADMIN_ID, leaked.replace("Bog'lanish: +998 90 123 45 67", "Savollar bo'lsa, botga yozing.")));
    expect(await env.DB.prepare("SELECT status FROM content_cases").first()).toEqual({ status: "DRAFT" });
    await postUpdate(app, callbackUpdate(ADMIN_ID, "cs:s:1"));
    expect(await env.DB.prepare("SELECT status FROM content_cases").first()).toEqual({ status: "SAFE_TO_USE" });

    const slotId = await seedSlot("TRUST", "2026-10-07", [cand("AI mavzu", "MASLAHAT", "https://x.example")]);
    await app.scheduled(at("2026-10-06T20:00:00Z"), env); // Wed 01:00
    expect(ai.created).toHaveLength(1); // the case, no new AI run
    expect(await env.DB.prepare("SELECT status FROM plan_slots WHERE id = ?").bind(slotId).first()).toEqual({ status: "READY" });
    expect(await env.DB.prepare("SELECT format, text FROM content_items").first<{ format: string; text: string }>()).toMatchObject({ format: "REAL_CASE" });
  });

  it("a voice message outside /case gets a hint, not a transcription", async () => {
    const tg = fakeTelegram();
    const ai = fakeAi();
    const { app } = makeApp(tg, new Date("2026-10-05T10:00:00Z"), undefined, undefined, undefined, ai);
    await postUpdate(app, voiceUpdate("v2", 10));
    expect(ai.transcribed).toHaveLength(0);
    expect(texts(tg).at(-1)).toContain("/case");
  });
});

describe("exhibitions, views, budget, reports", () => {
  it("/expo adds several lines and removes one; /season switches the mode", async () => {
    const tg = fakeTelegram();
    const { app } = makeApp(tg);
    await postUpdate(app, messageUpdate(ADMIN_ID, "/expo Canton Fair, Guangzhou\nCIIF, Shanghai"));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM exhibition_calendar WHERE status = 'CONFIRMED'").first()).toEqual({ n: 2 });
    await postUpdate(app, messageUpdate(ADMIN_ID, "/expo del 1"));
    expect(texts(tg).at(-1)).not.toContain("1. Canton");
    expect(texts(tg).at(-1)).toContain("CIIF, Shanghai");
    await postUpdate(app, messageUpdate(ADMIN_ID, "/season on"));
    expect(texts(tg).at(-1)).toContain("сезон выставок");
    await postUpdate(app, messageUpdate(CLIENT_ID, "/expo Fake, Nowhere"));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM exhibition_calendar").first()).toEqual({ n: 2 }); // clients cannot
  });

  it("/views records views for last week's posts in order", async () => {
    const tg = fakeTelegram();
    const { app } = makeApp(tg, new Date("2026-10-10T07:00:00Z"));
    for (const [i, rubric] of ["BUSINESS_MODEL", "TRUST"].entries()) {
      await env.DB.prepare("INSERT INTO content_items (text, status, rubric, topic, published_at, created_at) VALUES ('t', 'PUBLISHED', ?, ?, ?, ?)")
        .bind(rubric, `topic ${i}`, `2026-10-0${5 + i * 2}T05:00:00Z`, "2026-10-05T00:00:00Z")
        .run();
    }
    await postUpdate(app, messageUpdate(ADMIN_ID, "/views"));
    expect(texts(tg).at(-1)).toContain("Просмотры за неделю");
    await postUpdate(app, messageUpdate(ADMIN_ID, "1 200 950"));
    expect(texts(tg).at(-1)).toContain("не больше 2 чисел");
    await postUpdate(app, messageUpdate(ADMIN_ID, "1200 950"));
    const rows = await env.DB.prepare("SELECT views FROM content_items ORDER BY id").all();
    expect(rows.results).toEqual([{ views: 1200 }, { views: 950 }]);
  });

  it("the monthly budget stops new AI runs; /budget raises it", async () => {
    const tg = fakeTelegram();
    const ai = fakeAi();
    const { app } = makeApp(tg, new Date("2026-10-05T07:00:00Z"), undefined, undefined, undefined, ai);
    await env.DB.prepare("INSERT INTO ai_runs (kind, status, request, chat_id, extra_cost_usd, created_at, updated_at) VALUES ('TRANSCRIBE', 'DONE', '{}', 1, 10.5, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')").run();
    await postUpdate(app, messageUpdate(ADMIN_ID, "/find"));
    expect(texts(tg).at(-1)).toContain("Месячный бюджет OpenAI исчерпан");
    await postUpdate(app, messageUpdate(ADMIN_ID, "/budget 15"));
    expect(texts(tg).at(-1)).toContain("из $15");
    await postUpdate(app, messageUpdate(ADMIN_ID, "/find"));
    expect(texts(tg).filter((t) => t.includes("80%") || t.includes("Потрачено"))).toHaveLength(0); // 10.5 of 15 is below 80%
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE kind = 'DISCOVER'").first()).toEqual({ n: 1 });
  });

  it("the monthly report goes out once on the 1st at 09:00 with rubrics and AI spend", async () => {
    const tg = fakeTelegram();
    const { app } = makeApp(tg, new Date("2026-11-01T04:00:00Z"));
    await env.DB.prepare("INSERT INTO content_items (text, status, rubric, topic, published_at, created_at) VALUES ('t', 'PUBLISHED', 'TRUST', 'x', '2026-10-07T05:00:00Z', '2026-10-07T00:00:00Z')").run();
    await app.scheduled(at("2026-11-01T03:59:00Z"), env);
    expect(texts(tg).some((t) => t.includes("Отчёт за"))).toBe(false);
    await app.scheduled(at("2026-11-01T04:00:00Z"), env);
    await app.scheduled(at("2026-11-01T04:01:00Z"), env);
    const reports = texts(tg).filter((t) => t.includes("Отчёт за"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("доверие");
  });
});
