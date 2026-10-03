import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseCaption } from "../src/bot/magnets";
import type { TgUpdate } from "../src/telegram/types";
import { ADMIN_ID, CLIENT_ID, callbackUpdate, makeApp, messageUpdate, postUpdate } from "./helpers";

let nextId = 500_000;

function pdfUpload(caption: string, fileId = "file-abc", mime = "application/pdf", size = 1000): TgUpdate {
  const id = nextId++;
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: ADMIN_ID, is_bot: false, first_name: "Admin" },
      chat: { id: ADMIN_ID, type: "private" },
      date: 0,
      caption,
      document: { file_id: fileId, file_unique_id: `u-${fileId}`, file_name: "guide.pdf", mime_type: mime, file_size: size },
    },
  };
}

const magnets = () =>
  env.DB.prepare("SELECT id, slug, version, status, type, r2_key, tg_file_id FROM lead_magnets ORDER BY id").all<{
    id: number; slug: string; version: number; status: string; type: string; r2_key: string; tg_file_id: string;
  }>().then((r) => r.results);

async function uploadAndActivate(app: ReturnType<typeof makeApp>["app"], slug: string, fileId: string) {
  await postUpdate(app, pdfUpload(`${slug} | ${slug} guide`, fileId));
  const m = (await magnets()).filter((x) => x.slug === slug).at(-1)!;
  await postUpdate(app, callbackUpdate(ADMIN_ID, `lm:a:${m.id}`));
  await postUpdate(app, callbackUpdate(ADMIN_ID, `lm:c:${m.id}`));
  const funnel = await env.DB.prepare("SELECT code FROM funnels WHERE lead_magnet_slug = ? ORDER BY id DESC").bind(slug).first<{ code: string }>();
  return { magnet: m, code: funnel!.code };
}

describe("admin uploads", () => {
  it("parses the caption format", () => {
    expect(parseCaption("canton-fair-2027 | Canton Fair 2027")).toEqual({ slug: "canton-fair-2027", title: "Canton Fair 2027" });
    expect(parseCaption("Bad Slug | x")).toBeNull();
    expect(parseCaption("no-title")).toBeNull();
    expect(parseCaption(undefined)).toBeNull();
  });

  it("stores the PDF in R2 and creates a DRAFT version; a second upload becomes v2", async () => {
    const { app, tg } = makeApp();
    await postUpdate(app, pdfUpload("paper-cup | Qog'oz stakan", "f1"));
    await postUpdate(app, pdfUpload("paper-cup | Qog'oz stakan v2", "f2"));
    const rows = await magnets();
    expect(rows.map((r) => [r.version, r.status, r.tg_file_id])).toEqual([[1, "DRAFT", "f1"], [2, "DRAFT", "f2"]]);
    const object = await env.FILES.get("lead-magnets/paper-cup/v2.pdf");
    expect(await object?.text()).toContain("%PDF");
    expect(object?.customMetadata?.tg_file_unique_id).toBe("u-f2");
    expect(tg.calls.filter((c) => c.method === "downloadFile")).toHaveLength(2);
  });

  it("rejects non-PDF files, oversized files and bad captions without storing anything", async () => {
    const { app, tg } = makeApp();
    await postUpdate(app, pdfUpload("x-1 | Title", "a", "image/png"));
    await postUpdate(app, pdfUpload("x-1 | Title", "b", "application/pdf", 25 * 1024 * 1024));
    await postUpdate(app, pdfUpload("no caption format", "c"));
    expect(await magnets()).toHaveLength(0);
    const texts = tg.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.params.text));
    expect(texts[0]).toContain("не PDF");
    expect(texts[1]).toContain("20 МБ");
    expect(texts[2]).toContain("Не понял подпись");
  });

  it("ignores documents sent by clients", async () => {
    const { app } = makeApp();
    const update = pdfUpload("evil | Evil");
    update.message!.from!.id = CLIENT_ID;
    update.message!.chat.id = CLIENT_ID;
    await postUpdate(app, update);
    expect(await magnets()).toHaveLength(0);
  });

  it("activating a new version outdates the old one but keeps it", async () => {
    const { app } = makeApp();
    await uploadAndActivate(app, "canton", "f1");
    await uploadAndActivate(app, "canton", "f2");
    expect((await magnets()).map((r) => r.status)).toEqual(["OUTDATED", "ACTIVE"]);
  });

  it("lets the admin change the type of a draft and blocks magnet actions from clients", async () => {
    const { app } = makeApp();
    await postUpdate(app, pdfUpload("line | Line", "f1"));
    const [m] = await magnets();
    await postUpdate(app, callbackUpdate(CLIENT_ID, `lm:a:${m!.id}`));
    expect((await magnets())[0]!.status).toBe("DRAFT");
    await postUpdate(app, callbackUpdate(ADMIN_ID, `lm:t:${m!.id}:1`));
    expect((await magnets())[0]!.type).toBe("MANUFACTURING_MODEL");
  });

  it("creates campaign codes that are valid deep-link payloads", async () => {
    const { app } = makeApp();
    const { code } = await uploadAndActivate(app, "canton-fair-2027-spring-phase-one", "f1");
    expect(code).toBe("canton_fair_2027_spring_phase_one_c1");
    expect(code).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("client funnel", () => {
  it("sends intro, the PDF by file_id and the service offer; the lead becomes LEAD", async () => {
    const { app, tg } = makeApp();
    const { code, magnet } = await uploadAndActivate(app, "canton", "file-canton");
    tg.calls.length = 0;
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${code}`));
    const methods = tg.calls.map((c) => c.method);
    expect(methods).toEqual(["sendMessage", "sendDocument", "sendMessage"]);
    expect(tg.calls[1]!.params.document).toBe("file-canton");
    expect(JSON.stringify(tg.calls[2]!.params.reply_markup)).toContain(`cta:${magnet.id}:`);
    const lead = await env.DB.prepare("SELECT l.stage, l.score FROM leads l JOIN users u ON u.id = l.user_id WHERE u.tg_user_id = ?")
      .bind(CLIENT_ID).first<{ stage: string; score: number }>();
    expect(lead).toEqual({ stage: "LEAD", score: 1 });
  });

  it("two different PDFs make the lead ENGAGED without duplicating the person", async () => {
    const { app } = makeApp();
    const a = await uploadAndActivate(app, "canton", "fa");
    const b = await uploadAndActivate(app, "paper-cup", "fb");
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${a.code}`));
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${b.code}`));
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${a.code}`));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE tg_user_id = ?").bind(CLIENT_ID).first<{ n: number }>())?.n).toBe(1);
    const lead = await env.DB.prepare("SELECT l.stage, l.score FROM leads l JOIN users u ON u.id = l.user_id WHERE u.tg_user_id = ?")
      .bind(CLIENT_ID).first<{ stage: string; score: number }>();
    expect(lead).toEqual({ stage: "ENGAGED", score: 2 });
  });

  it("a campaign whose lead magnet is not active falls back to the 'not available' text", async () => {
    const { app, tg } = makeApp();
    await postUpdate(app, pdfUpload("draft-only | Draft", "f1"));
    await env.DB.prepare("INSERT INTO funnels (code, kind, lead_magnet_slug, created_at) VALUES ('draft_c1','EXHIBITION','draft-only','x')").run();
    tg.calls.length = 0;
    await postUpdate(app, messageUpdate(CLIENT_ID, "/start draft_c1"));
    expect(tg.calls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(String(tg.calls[0]!.params.text)).toContain("mavjud emas");
  });

  it("'Muhokama qilmoqchiman' marks INTERESTED once, notifies the admin and starts the questions", async () => {
    const { app, tg } = makeApp();
    const { code, magnet } = await uploadAndActivate(app, "canton", "fc");
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${code}`));
    const funnelId = (await env.DB.prepare("SELECT id FROM funnels WHERE code = ?").bind(code).first<{ id: number }>())!.id;
    tg.calls.length = 0;
    await postUpdate(app, callbackUpdate(CLIENT_ID, `cta:${magnet.id}:${funnelId}`));
    await postUpdate(app, callbackUpdate(CLIENT_ID, `cta:${magnet.id}:${funnelId}`));

    const toAdmin = tg.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === ADMIN_ID);
    expect(toAdmin).toHaveLength(1);
    expect(String(toAdmin[0]!.params.text)).toContain("canton guide");
    expect(String(toAdmin[0]!.params.text)).toContain(code);
    const toClient = tg.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === CLIENT_ID).map((c) => String(c.params.text));
    expect(toClient[0]).toContain("bir nechta qisqa savol");
    expect(toClient[1]).toContain("1/3. Necha kishi");
    expect(toClient[2]).toContain("allaqachon");
    const lead = await env.DB.prepare("SELECT l.stage, l.score FROM leads l JOIN users u ON u.id = l.user_id WHERE u.tg_user_id = ?")
      .bind(CLIENT_ID).first<{ stage: string; score: number }>();
    expect(lead).toEqual({ stage: "INTERESTED", score: 4 });
  });

  it("uses a template override from settings", async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('tpl.welcome', ?)").bind(JSON.stringify("Custom salom")).run();
    const { app, tg } = makeApp();
    await postUpdate(app, messageUpdate(CLIENT_ID, "/start"));
    expect(tg.calls[0]!.params.text).toBe("Custom salom");
  });

  it("dashboard and magnet list show deliveries", async () => {
    const { app, tg } = makeApp();
    const { code } = await uploadAndActivate(app, "canton", "fd");
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${code}`));
    tg.calls.length = 0;
    await postUpdate(app, callbackUpdate(ADMIN_ID, "adm:dashboard"));
    await postUpdate(app, callbackUpdate(ADMIN_ID, "adm:magnets"));
    const [dash, list] = tg.calls.filter((c) => c.method === "editMessageText");
    expect(String(dash!.params.text)).toContain("Выдано PDF за 24 ч: <b>1</b>");
    expect(JSON.stringify(list!.params.reply_markup)).toContain("1↓");
  });
});
