// SYSTEM_STATUS master switch: only ACTIVE lets the bot reach OpenAI or run scheduled AI work.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { systemActive } from "../src/env";
import { ADMIN_ID, CLIENT_ID, fakeAi, fakeTelegram, makeApp, messageUpdate, postUpdate } from "./helpers";

const at = (iso: string) => ({ scheduledTime: Date.parse(iso) });

describe("safe pause", () => {
  it("anything but ACTIVE counts as paused", () => {
    expect(systemActive({ SYSTEM_STATUS: "ACTIVE" })).toBe(true);
    expect(systemActive({ SYSTEM_STATUS: " active " })).toBe(true);
    for (const v of ["PAUSED", "", "ACTIV", "on", undefined]) expect(systemActive({ SYSTEM_STATUS: v })).toBe(false);
  });

  for (const status of ["PAUSED", undefined, "typo"]) {
    it(`status ${String(status)}: no AI calls from cron or messages, no plan, no reports; clients still get answers`, async () => {
      const paused = { ...env, SYSTEM_STATUS: status } as typeof env;
      const tg = fakeTelegram();
      const ai = fakeAi();
      const { app } = makeApp(tg, new Date("2026-10-10T07:00:00Z"), undefined, undefined, undefined, ai);
      // A run left in the queue from before the pause must not start.
      await env.DB.prepare("INSERT INTO ai_runs (kind, request, chat_id, created_at, updated_at) VALUES ('DISCOVER', '{}', ?, '2026-10-09T00:00:00Z', '2026-10-09T00:00:00Z')").bind(ADMIN_ID).run();

      for (const iso of ["2026-10-10T04:00:00Z", "2026-10-10T07:00:00Z", "2026-10-10T07:01:00Z", "2026-11-01T04:00:00Z"]) {
        await app.scheduled(at(iso), paused); // Sat 09:00 report, Sat 12:00 plan, 1st of month report
      }
      const send = (text: string, from = ADMIN_ID) =>
        app.fetch(
          new Request("https://bot.example.workers.dev/tg/webhook", {
            method: "POST",
            headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-webhook-secret" },
            body: JSON.stringify(messageUpdate(from, text)),
          }),
          paused,
        );
      await send("/find");
      expect(String(tg.calls.at(-1)!.params.text)).toContain("система на паузе");
      await send("/breaking test");
      await send("/plan");
      await send("/start", CLIENT_ID);
      expect(String(tg.calls.at(-1)!.params.text)).toContain("Assalomu alaykum"); // the bot still answers clients

      expect(ai.created).toHaveLength(0);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_runs").first()).toEqual({ n: 1 });
      expect(await env.DB.prepare("SELECT status FROM ai_runs").first()).toEqual({ status: "QUEUED" });
      // The Saturday cron made no plan; the manual /plan left only a FAILED row that a later /plan replaces.
      expect((await env.DB.prepare("SELECT status FROM content_plans").all()).results).toEqual([{ status: "FAILED" }]);
      expect(tg.calls.some((c) => /Отчёт за|Утренний|за вчера/.test(String(c.params.text ?? "")))).toBe(false);
    });
  }

  it("ACTIVE again: the queued run starts on the next tick", async () => {
    const tg = fakeTelegram();
    const ai = fakeAi();
    const { app } = makeApp(tg, new Date("2026-10-07T05:00:00Z"), undefined, undefined, undefined, ai);
    await postUpdate(app, messageUpdate(ADMIN_ID, "/find"));
    await app.scheduled(at("2026-10-07T05:00:00Z"), env);
    expect(ai.created).toHaveLength(1);
  });
});
