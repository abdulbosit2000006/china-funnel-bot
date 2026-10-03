import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { makeApp } from "./helpers";

it("removes processed update ids older than a week once an hour", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO processed_updates VALUES (1, '2026-09-01T00:00:00.000Z')"),
    env.DB.prepare("INSERT INTO processed_updates VALUES (2, '2026-10-03T11:00:00.000Z')"),
  ]);
  const { app } = makeApp();
  await app.scheduled({ scheduledTime: Date.parse("2026-10-03T12:01:00Z") }, env);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM processed_updates").first<{ n: number }>())?.n).toBe(2);
  await app.scheduled({ scheduledTime: Date.parse("2026-10-03T12:00:00Z") }, env);
  const left = await env.DB.prepare("SELECT update_id FROM processed_updates").all<{ update_id: number }>();
  expect(left.results.map((r) => r.update_id)).toEqual([2]);
});
