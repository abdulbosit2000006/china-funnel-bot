import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { normalizeUrl, wasSeen } from "../src/ai/openai";
import fixture from "./fixtures/exhibition-research.json";
import { ADMIN_ID, CLIENT_ID, aiAnswer, callbackUpdate, fakeAi, fakeTelegram, makeApp, messageUpdate, postUpdate } from "./helpers";

const tick = (app: ReturnType<typeof makeApp>["app"], minute: number) =>
  app.scheduled({ scheduledTime: Date.parse(`2026-10-03T13:${String(minute).padStart(2, "0")}:00Z`) }, env);

function setup() {
  const tg = fakeTelegram();
  const ai = fakeAi();
  const { app } = makeApp(tg, new Date("2026-10-03T13:00:00Z"), undefined, undefined, undefined, ai);
  return { tg, ai, app };
}

const texts = (tg: ReturnType<typeof fakeTelegram>) => tg.calls.map((c) => String(c.params.text ?? c.params.caption ?? ""));
const runs = () => env.DB.prepare("SELECT id, kind, status, rounds, response_id, web_searches FROM ai_runs ORDER BY id").all().then((r) => r.results);

const candidates = {
  candidates: [
    {
      name: "CIIF", edition: "2027", full_name: "China International Industry Fair", city: "Shanghai", dates: "sentabr 2027",
      industry: "sanoat", official_site: "https://www.ciif-expo.com", why: "Stanoklar va avtomatlashtirish.", source_url: "https://www.ciif-expo.com/en/",
    },
    {
      name: "SIAL China", edition: "2027", full_name: "SIAL China", city: "Shanghai", dates: "may 2027",
      industry: "oziq-ovqat", official_site: "https://www.sialchina.com", why: "Oziq-ovqat xomashyosi.", source_url: "https://made-up.example/sial",
    },
  ],
};

const researchJson = () => {
  const data = structuredClone(fixture) as Record<string, unknown>;
  data.sample = true; // the model must not be able to mark its own work as a sample
  return JSON.stringify(data);
};
const fixtureUrls = fixture.sources.map((s) => s.url);

describe("AI research", () => {
  it("without an OpenAI key the admin is told how to connect it", async () => {
    const tg = fakeTelegram();
    const { app } = makeApp(tg);
    await postUpdate(app, messageUpdate(ADMIN_ID, "/find"));
    expect(texts(tg).at(-1)).toContain("OPENAI_API_KEY");
    expect(await runs()).toEqual([]);
  });

  it("finds exhibitions in the background, lists them with research buttons and flags sources it never saw", async () => {
    const { tg, ai, app } = setup();
    await postUpdate(app, messageUpdate(ADMIN_ID, "/find metall"));
    expect(texts(tg).at(-1)).toContain("«metall»");

    await tick(app, 1);
    expect(ai.created).toHaveLength(1);
    expect(ai.created[0]).toMatchObject({ background: true, tools: [{ type: "web_search" }], include: ["web_search_call.action.sources"] });
    expect(JSON.stringify(ai.created[0]!.input)).toContain("metall");

    await tick(app, 2); // still running
    expect((await runs())[0]).toMatchObject({ status: "RUNNING", response_id: "resp_1" });

    ai.answers.resp_1 = aiAnswer("resp_1", "```json\n" + JSON.stringify(candidates) + "\n```", ["https://ciif-expo.com/en"]);
    await tick(app, 3);
    expect((await runs())[0]).toMatchObject({ status: "DONE", web_searches: 2 });
    const list = tg.calls.at(-1)!;
    expect(String(list.params.text)).toContain("CIIF 2027");
    expect(String(list.params.text).match(/источник не из поиска/g)).toHaveLength(1); // only SIAL's made-up URL
    expect(String(list.params.text)).toContain("≈$");
    const buttons = JSON.stringify(list.params.reply_markup);
    expect(buttons).toContain(`ai:r:1:0`);
    expect(buttons).toContain(`ai:r:1:1`);
  });

  it("research from a candidate becomes a DRAFT package with our date and no sample mark, and the PDF is queued", async () => {
    const { tg, ai, app } = setup();
    await postUpdate(app, messageUpdate(ADMIN_ID, "/find"));
    await tick(app, 1);
    ai.answers.resp_1 = aiAnswer("resp_1", JSON.stringify(candidates));
    await tick(app, 2);

    await postUpdate(app, callbackUpdate(ADMIN_ID, "ai:r:1:0"));
    expect(texts(tg).at(-1)).toContain("CIIF 2027");
    await tick(app, 3);
    expect(JSON.stringify(ai.created[1]!.input)).toContain("China International Industry Fair");

    ai.answers.resp_2 = aiAnswer("resp_2", researchJson(), fixtureUrls);
    await tick(app, 4);
    const item = await env.DB.prepare("SELECT status, research_date, data, ai_cost_usd FROM research_items").first<{ status: string; research_date: string; data: string; ai_cost_usd: number }>();
    expect(item!.research_date).toBe("2026-10-03");
    expect(JSON.parse(item!.data).sample).toBe(false);
    expect(item!.ai_cost_usd).toBeGreaterThan(0);
    // The same tick that stored the package may already render it; either way the PDF goes through review.
    expect(["DRAFT", "IN_REVIEW"]).toContain(item!.status);
    expect(texts(tg).some((t) => t.includes("Все источники взяты из результатов поиска"))).toBe(true);
    expect((await runs())[1]).toMatchObject({ kind: "RESEARCH", status: "DONE" });
  });

  it("asks the model to fix an invalid package once, then gives up with the errors and the raw answer", async () => {
    const { tg, ai, app } = setup();
    await postUpdate(app, messageUpdate(ADMIN_ID, "/research CIIF Shanghai 2027"));
    await tick(app, 1);
    ai.answers.resp_1 = aiAnswer("resp_1", JSON.stringify({ ...fixture, inputs: [] }));
    await tick(app, 2);
    expect(ai.created[1]).toMatchObject({ previous_response_id: "resp_1", background: true });
    expect(JSON.stringify(ai.created[1]!.input)).toContain("inputs: нужен список расходов");
    expect((await runs())[0]).toMatchObject({ status: "RUNNING", rounds: 2, response_id: "resp_2" });

    ai.answers.resp_2 = aiAnswer("resp_2", "Kechirasiz, topa olmadim.");
    await tick(app, 3);
    expect((await runs())[0]).toMatchObject({ status: "FAILED" });
    expect(texts(tg).some((t) => t.includes("research-пакет не прошёл проверку"))).toBe(true);
    expect(tg.calls.at(-1)).toMatchObject({ method: "sendDocument", params: { document: "<file ai-research-1.json>" } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM research_items").first()).toEqual({ n: 0 });
  });

  it("a failed OpenAI response is reported; the daily limit protects the budget", async () => {
    const { tg, ai, app } = setup();
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ai.daily_limit', '2')").run();
    await postUpdate(app, messageUpdate(ADMIN_ID, "/find"));
    await tick(app, 1);
    ai.answers.resp_1 = { id: "resp_1", status: "failed", error: { message: "insufficient_quota" } };
    await tick(app, 2);
    expect(texts(tg).at(-1)).toContain("insufficient_quota");

    await postUpdate(app, messageUpdate(ADMIN_ID, "/find"));
    await postUpdate(app, messageUpdate(ADMIN_ID, "/find"));
    expect(texts(tg).at(-1)).toContain("Дневной лимит");
    expect(await runs()).toHaveLength(2);
  });

  it("clients cannot start AI runs", async () => {
    const { tg, app } = setup();
    await postUpdate(app, messageUpdate(CLIENT_ID, "/find"));
    await postUpdate(app, callbackUpdate(CLIENT_ID, "ai:d"));
    expect(await runs()).toEqual([]);
    expect(texts(tg).some((t) => t.includes("Ищу выставки"))).toBe(false);
  });

  it("matches source URLs regardless of scheme, www and trailing slash", () => {
    expect(normalizeUrl("https://www.Example.com/a/")).toBe("example.com/a");
    const seen = new Set(["example.com/a?x=1"]);
    expect(wasSeen("http://example.com/a", seen)).toBe(true);
    expect(wasSeen("https://example.com/b", seen)).toBe(false);
  });
});
