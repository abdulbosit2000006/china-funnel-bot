import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ADMIN_ID, CLIENT_ID, callbackUpdate, fakeTelegram, makeApp, messageUpdate, postUpdate } from "./helpers";

const T0 = "2026-10-03T10:00:00.000Z";

async function seedMagnet(slug: string, type = "EXHIBITION_GUIDE") {
  const m = await env.DB.prepare(
    `INSERT INTO lead_magnets (slug, version, type, title, status, r2_key, tg_file_id, created_at, updated_at)
     VALUES (?, 1, ?, ?, 'ACTIVE', 'k', ?, ?, ?) RETURNING id`,
  ).bind(slug, type, `${slug} guide`, `file-${slug}`, T0, T0).first<{ id: number }>();
  const code = `${slug.replace(/-/g, "_")}_c1`;
  const f = await env.DB.prepare("INSERT INTO funnels (code, kind, lead_magnet_slug, created_at) VALUES (?, 'EXHIBITION', ?, ?) RETURNING id")
    .bind(code, slug, T0).first<{ id: number }>();
  return { magnetId: m!.id, funnelId: f!.id, code };
}

function appAt(iso: string, tg = fakeTelegram()) {
  return { ...makeApp(tg, new Date(iso)), tg };
}
const tick = (app: ReturnType<typeof makeApp>["app"], iso: string) => app.scheduled({ scheduledTime: Date.parse(iso) }, env);
const toClient = (tg: ReturnType<typeof fakeTelegram>) =>
  tg.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === CLIENT_ID);
const toAdmin = (tg: ReturnType<typeof fakeTelegram>) =>
  tg.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === ADMIN_ID).map((c) => String(c.params.text));
const lead = () =>
  env.DB.prepare("SELECT l.stage, l.score, l.answers, l.hot_signal_at FROM leads l JOIN users u ON u.id = l.user_id WHERE u.tg_user_id = ?")
    .bind(CLIENT_ID).first<{ stage: string; score: number; answers: string | null; hot_signal_at: string | null }>();
const buttons = (call: { params: Record<string, unknown> }) =>
  (call.params.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }).inline_keyboard.flat();

describe("follow-up", () => {
  it("is sent once after the delay, not before, and its 'Qiziqaman' starts the questions", async () => {
    const { code } = await seedMagnet("canton");
    const { app, tg } = appAt(T0);
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${code}`));
    tg.calls.length = 0;

    await tick(app, "2026-10-03T11:00:00Z"); // 1 h later: too early
    expect(toClient(tg)).toHaveLength(0);
    await tick(app, "2026-10-03T12:31:00Z"); // 2.5 h later
    const fu = toClient(tg);
    expect(fu).toHaveLength(1);
    expect(String(fu[0]!.params.text)).toContain("ulgurdingizmi");
    expect(buttons(fu[0]!).map((b) => b.text)).toEqual(["✅ Qiziqaman", "❓ Savolim bor", "⏸ Hozir emas"]);
    await tick(app, "2026-10-03T13:00:00Z");
    expect(toClient(tg)).toHaveLength(1); // never twice

    await postUpdate(app, callbackUpdate(CLIENT_ID, buttons(fu[0]!)[0]!.callback_data!));
    expect(String(toClient(tg).at(-1)!.params.text)).toContain("1/3. Necha kishi");
    expect((await lead())!.stage).toBe("INTERESTED");
    expect(toAdmin(tg).some((t) => t.includes("Клиент заинтересовался"))).toBe(true);
  });

  it("is cancelled when the person already pressed the service button, and at most one per day across PDFs", async () => {
    const a = await seedMagnet("canton");
    const b = await seedMagnet("ciif");
    const { app, tg } = appAt(T0);
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${a.code}`));
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${b.code}`));
    await postUpdate(app, callbackUpdate(CLIENT_ID, `cta:${a.magnetId}:${a.funnelId}`));
    tg.calls.length = 0;
    await tick(app, "2026-10-03T13:00:00Z");
    const statuses = await env.DB.prepare("SELECT status, cancel_reason FROM followups ORDER BY id").all();
    expect(statuses.results).toEqual([
      { status: "CANCELLED", cancel_reason: "already_engaged" },
      { status: "SENT", cancel_reason: null },
    ]);
    expect(toClient(tg)).toHaveLength(1);
  });

  it("'Savolim bor' forwards the next message to the founder; 'Hozir emas' just thanks", async () => {
    const { code } = await seedMagnet("canton");
    const { app, tg } = appAt(T0);
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${code}`));
    await tick(app, "2026-10-03T13:00:00Z");
    const fu = toClient(tg).at(-1)!;
    await postUpdate(app, callbackUpdate(CLIENT_ID, buttons(fu)[1]!.callback_data!));
    expect(String(toClient(tg).at(-1)!.params.text)).toContain("Savolingizni");
    await postUpdate(app, messageUpdate(CLIENT_ID, "Viza kerakmi?"));
    expect(toAdmin(tg).at(-1)).toContain("Вопрос от клиента");
    expect(toAdmin(tg).at(-1)).toContain("Viza kerakmi?");
    expect(String(toClient(tg).at(-1)!.params.text)).toContain("Savolingiz mutaxassisga yuborildi");
    await postUpdate(app, messageUpdate(CLIENT_ID, "salom"));
    expect(String(toClient(tg).at(-1)!.params.text)).toContain("kanalimizdagi post"); // back to normal
  });

  it("does not message people who blocked the bot", async () => {
    const { code } = await seedMagnet("canton");
    const { app, tg } = appAt(T0);
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${code}`));
    await env.DB.prepare("UPDATE users SET is_blocked_bot = 1").run();
    tg.calls.length = 0;
    await tick(app, "2026-10-03T13:00:00Z");
    expect(toClient(tg)).toHaveLength(0);
    expect(await env.DB.prepare("SELECT status FROM followups").first()).toEqual({ status: "CANCELLED" });
  });
});

describe("qualification", () => {
  it("manufacturing questions → QUALIFIED card with answers and founder buttons", async () => {
    const m = await seedMagnet("paper-cup", "MANUFACTURING_MODEL");
    const { app, tg } = appAt(T0);
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${m.code}`));
    await postUpdate(app, callbackUpdate(CLIENT_ID, `cta:${m.magnetId}:${m.funnelId}`));
    for (let step = 0; step < 4; step++) {
      const q = toClient(tg).at(-1)!;
      expect(String(q.params.text)).toContain(`${step + 1}/4.`);
      await postUpdate(app, callbackUpdate(CLIENT_ID, buttons(q)[1]!.callback_data!));
    }
    expect(String(toClient(tg).at(-1)!.params.text)).toContain("Ma'lumotlar mutaxassisga yuborildi");
    const l = (await lead())!;
    expect(l.stage).toBe("QUALIFIED");
    expect(l.score).toBe(1 + 3 + 5);
    expect(JSON.parse(l.answers!)).toEqual({ "paper-cup": { budget: "$20–50 ming", location: "Viloyatda", timeline: "6–12 oy", sourcing: "Yo'q, faqat maslahat" } });
    const card = tg.calls.filter((c) => c.params.chat_id === ADMIN_ID).at(-1)!;
    expect(String(card.params.text)).toContain("QUALIFIED LEAD");
    expect(String(card.params.text)).toContain("Viloyatda");
    const userId = (await env.DB.prepare("SELECT id FROM users WHERE tg_user_id = ?").bind(CLIENT_ID).first<{ id: number }>())!.id;
    expect(buttons(card).map((b) => b.callback_data ?? b.text)).toEqual(["💬 Открыть чат", `lc:c:${userId}`, `lc:n:${userId}`]);

    // A client cannot press founder buttons; the founder can.
    await postUpdate(app, callbackUpdate(CLIENT_ID, `lc:c:${userId}`));
    expect((await lead())!.stage).toBe("QUALIFIED");
    await postUpdate(app, callbackUpdate(ADMIN_ID, `lc:c:${userId}`));
    expect((await lead())!.stage).toBe("CONTACTED");
  });

  it("a double tap on an answer is ignored", async () => {
    const m = await seedMagnet("canton");
    const { app, tg } = appAt(T0);
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${m.code}`));
    await postUpdate(app, callbackUpdate(CLIENT_ID, `cta:${m.magnetId}:${m.funnelId}`));
    const q = toClient(tg).at(-1)!;
    await postUpdate(app, callbackUpdate(CLIENT_ID, buttons(q)[0]!.callback_data!));
    await postUpdate(app, callbackUpdate(CLIENT_ID, buttons(q)[2]!.callback_data!));
    expect(JSON.parse((await lead())!.answers!)).toEqual({ canton: { travelers: "1 kishi" } });
    expect(toClient(tg).filter((c) => String(c.params.text).startsWith("2/3."))).toHaveLength(1);
  });
});

describe("engagement signal", () => {
  it("three different PDFs from one person notify the founder once, labelled as a signal", async () => {
    const codes = [await seedMagnet("a-1"), await seedMagnet("b-2"), await seedMagnet("c-3")].map((m) => m.code);
    const { app, tg } = appAt(T0);
    for (const code of codes) await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${code}`));
    await postUpdate(app, messageUpdate(CLIENT_ID, `/start ${codes[0]}`));
    const signals = toAdmin(tg).filter((t) => t.includes("Сигнал вовлечённости"));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toContain("не гарантия покупки");
    expect((await lead())!.hot_signal_at).not.toBeNull();
  });
});

