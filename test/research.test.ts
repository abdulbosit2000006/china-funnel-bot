import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { calculateBudget, validateResearch, type ExhibitionResearch } from "../src/pdf/exhibition";
import type { TgUpdate } from "../src/telegram/types";
import fixture from "./fixtures/exhibition-research.json";
import { ADMIN_ID, CLIENT_ID, callbackUpdate, fakeRenderer, fakeTelegram, makeApp, messageUpdate, postUpdate } from "./helpers";

const research = () => structuredClone(fixture) as unknown as ExhibitionResearch;
let nextId = 700_000;

function jsonUpload(fileId: string, fromId = ADMIN_ID): TgUpdate {
  const id = nextId++;
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: fromId, is_bot: false, first_name: "Admin" },
      chat: { id: fromId, type: "private" },
      date: 0,
      document: { file_id: fileId, file_unique_id: `u-${fileId}`, file_name: "research.json", mime_type: "application/json", file_size: 5000 },
    },
  };
}

const tick = (app: ReturnType<typeof makeApp>["app"], iso = "2026-10-03T12:01:00Z") =>
  app.scheduled({ scheduledTime: Date.parse(iso) }, env);

const items = () =>
  env.DB.prepare("SELECT id, status, slug, pdf_r2_key, pdf_tg_file_id, lead_magnet_id FROM research_items ORDER BY id")
    .all<{ id: number; status: string; slug: string; pdf_r2_key: string | null; pdf_tg_file_id: string | null; lead_magnet_id: number | null }>()
    .then((r) => r.results);

describe("budget calculation", () => {
  it("multiplies inputs by scenario factors, adds the reserve and skips UNKNOWN rows", () => {
    const b = calculateBudget(research());
    const row = (key: string) => b.rows.find((r) => r.key === key)!;
    expect(row("flight").amount).toBe(1300); // $650 × 2 people
    expect(row("hotel").amount).toBe(1020); // $85 × 2 rooms × 6 nights
    expect(row("hotel").formula).toBe("$85 × 2 xona × 6 kecha");
    expect(row("visa").amount).toBeNull();
    expect(b.subtotal).toBe(3164);
    expect(b.reserve).toBe(316);
    expect(b.total).toBe(3480);
    expect(b.perPerson).toBe(1740);
    expect(b.excluded.map((r) => r.key)).toEqual(["visa"]);
    expect(b.weakest).toBe("ASSUMPTION");
  });

  it("follows the scenario: 3 people cost more for per-person items only", () => {
    const data = research();
    data.scenario.people = 3;
    const b = calculateBudget(data);
    expect(b.rows.find((r) => r.key === "flight")!.amount).toBe(1950);
    expect(b.rows.find((r) => r.key === "hotel")!.amount).toBe(1020);
  });
});

describe("research validation", () => {
  it("accepts the reference package", () => {
    expect(validateResearch(research())).toMatchObject({ ok: true });
  });

  it("rejects a price on an UNKNOWN row, a dangling source and a bad factor", () => {
    const data = research() as unknown as Record<string, any>;
    data.inputs[5].unit_price = 60; // visa is UNKNOWN
    data.inputs[0].source = 99;
    data.inputs[1].factors = [["guests", "kishi"]];
    const result = validateResearch(data);
    expect(result.ok).toBe(false);
    const errors = (result as { errors: string[] }).errors.join("\n");
    expect(errors).toContain("у UNKNOWN цена должна быть null");
    expect(errors).toContain("[99]");
    expect(errors).toContain("inputs[1] (hotel).factors");
  });

  it("rejects something that is not a package at all", () => {
    expect(validateResearch([1, 2])).toMatchObject({ ok: false });
    expect(validateResearch({ slug: "Bad Slug" })).toMatchObject({ ok: false });
  });
});

describe("research → PDF → approval", () => {
  it("renders the PDF in the cron, stores it in R2 and sends it to the admin with approve buttons", async () => {
    const tg = fakeTelegram({ "documents/r1.json": JSON.stringify(fixture) });
    const renderer = fakeRenderer();
    const { app } = makeApp(tg, undefined, renderer);

    await postUpdate(app, jsonUpload("r1"));
    expect((await items()).map((i) => i.status)).toEqual(["DRAFT"]);
    expect(String(tg.calls.at(-1)!.params.text)).toContain("$3 480");

    await tick(app);
    const [item] = await items();
    expect(item!.status).toBe("IN_REVIEW");
    expect(item!.pdf_tg_file_id).toBe("generated-1");
    expect(await (await env.FILES.get(item!.pdf_r2_key!))?.text()).toBe("%PDF-1.7 generated");

    const html = renderer.rendered[0]!.html;
    expect(html).toContain("abdulbosit_source");
    expect(html).toContain("$3 480");
    expect(html).toContain("@test_bot");
    expect(html).toContain("NAMUNA"); // the fixture is marked as a sample
    expect(html).not.toMatch(/\$ ___|kuniga|Tayyorgarlik paketi/); // no prices or packages in the PDF

    const sent = tg.calls.find((c) => c.method === "sendDocument")!;
    expect(sent.params.chat_id).toBe(String(ADMIN_ID));
    expect(String(sent.params.reply_markup)).toContain(`rp:a:${item!.id}`);

    // A second tick has nothing left to do.
    await tick(app, "2026-10-03T12:02:00Z");
    expect(renderer.rendered).toHaveLength(1);
  });

  it("approve turns the PDF into an active lead magnet with a campaign link that delivers it", async () => {
    const tg = fakeTelegram({ "documents/r2.json": JSON.stringify(fixture) });
    const { app } = makeApp(tg);
    await postUpdate(app, jsonUpload("r2"));
    await tick(app);
    const [item] = await items();

    await postUpdate(app, callbackUpdate(ADMIN_ID, `rp:a:${item!.id}`));
    await postUpdate(app, callbackUpdate(ADMIN_ID, `rp:a:${item!.id}`)); // double tap is harmless
    const magnets = await env.DB.prepare("SELECT id, slug, status, tg_file_id, research_item_id FROM lead_magnets").all();
    expect(magnets.results).toEqual([
      { id: expect.any(Number), slug: "canton-fair-2027-spring", status: "ACTIVE", tg_file_id: "generated-1", research_item_id: item!.id },
    ]);
    expect((await items())[0]!.status).toBe("ACTIVE");

    const funnel = await env.DB.prepare("SELECT code FROM funnels WHERE lead_magnet_slug = ?").bind("canton-fair-2027-spring").first<{ code: string }>();
    expect(funnel).not.toBeNull();
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${funnel!.code}`));
    const delivered = tg.calls.filter((c) => c.method === "sendDocument" && c.params.chat_id === CLIENT_ID);
    expect(delivered.map((c) => c.params.document)).toEqual(["generated-1"]);
  });

  it("reject keeps the PDF away from clients", async () => {
    const tg = fakeTelegram({ "documents/r3.json": JSON.stringify(fixture) });
    const { app } = makeApp(tg);
    await postUpdate(app, jsonUpload("r3"));
    await tick(app);
    const [item] = await items();
    await postUpdate(app, callbackUpdate(ADMIN_ID, `rp:r:${item!.id}`));
    expect((await items())[0]!.status).toBe("REJECTED");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM lead_magnets").first<{ n: number }>())!.n).toBe(0);
  });

  it("invalid packages are explained and nothing is queued; clients cannot upload or approve", async () => {
    const bad = { ...fixture, inputs: [] };
    const tg = fakeTelegram({ "documents/bad.json": JSON.stringify(bad), "documents/c.json": JSON.stringify(fixture) });
    const { app } = makeApp(tg);
    await postUpdate(app, jsonUpload("bad"));
    expect(String(tg.calls.at(-1)!.params.text)).toContain("inputs: нужен список расходов");
    await postUpdate(app, jsonUpload("c", CLIENT_ID));
    await postUpdate(app, callbackUpdate(CLIENT_ID, "rp:a:1"));
    expect(await items()).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())!.n).toBe(0);
  });

  it("retries a failed render and tells the admin after the last attempt", async () => {
    const tg = fakeTelegram({ "documents/r4.json": JSON.stringify(fixture) });
    const failing = Object.assign(async () => {
      throw new Error("browser unavailable");
    }, { rendered: [] });
    const { app } = makeApp(tg, undefined, failing);
    await postUpdate(app, jsonUpload("r4"));
    await tick(app, "2026-10-03T12:01:00Z");
    await tick(app, "2026-10-03T12:04:00Z");
    await tick(app, "2026-10-03T12:07:00Z");
    const job = await env.DB.prepare("SELECT status, attempts, last_error FROM jobs").first();
    expect(job).toEqual({ status: "FAILED", attempts: 3, last_error: "browser unavailable" });
    expect(String(tg.calls.at(-1)!.params.text)).toContain("Не удалось создать PDF");
    expect((await items())[0]!.status).toBe("DRAFT");
  });
});
