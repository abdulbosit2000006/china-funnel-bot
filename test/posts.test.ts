import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TgUpdate } from "../src/telegram/types";
import fixture from "./fixtures/exhibition-research.json";
import { ADMIN_ID, CLIENT_ID, callbackUpdate, fakeTelegram, makeApp, messageUpdate, postUpdate } from "./helpers";

const CHANNEL_ID = -1001234567890;
let nextId = 800_000;

function channelMember(fromId: number, status: string): TgUpdate {
  return {
    update_id: nextId++,
    my_chat_member: {
      chat: { id: CHANNEL_ID, type: "channel", title: "Xitoy sanoat bozori" },
      from: { id: fromId, is_bot: false, first_name: "Owner" },
      new_chat_member: { status, user: { id: 42, is_bot: true, first_name: "bot" } },
    },
  };
}

function jsonUpload(fileId: string): TgUpdate {
  const id = nextId++;
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: ADMIN_ID, is_bot: false, first_name: "Admin" },
      chat: { id: ADMIN_ID, type: "private" },
      date: 0,
      document: { file_id: fileId, file_unique_id: `u-${fileId}`, file_name: "r.json", mime_type: "application/json", file_size: 5000 },
    },
  };
}

/** Upload research → render → approve; returns the app with a post preview waiting. */
async function approvedResearch() {
  const tg = fakeTelegram({ "documents/r.json": JSON.stringify(fixture) });
  const { app } = makeApp(tg);
  await postUpdate(app, jsonUpload("r"));
  await app.scheduled({ scheduledTime: Date.parse("2026-10-03T12:01:00Z") }, env);
  const item = await env.DB.prepare("SELECT id FROM research_items").first<{ id: number }>();
  await postUpdate(app, callbackUpdate(ADMIN_ID, `rp:a:${item!.id}`));
  const post = await env.DB.prepare("SELECT id, status, text, funnel_id FROM content_items").first<{ id: number; status: string; text: string; funnel_id: number }>();
  return { app, tg, post: post! };
}

const postStatus = (id: number) =>
  env.DB.prepare("SELECT status, channel_message_id FROM content_items WHERE id = ?").bind(id).first<{ status: string; channel_message_id: number | null }>();

describe("channel post", () => {
  it("approving research drafts a post with the budget teaser and a deep-link button to the PDF", async () => {
    const { tg, post } = await approvedResearch();
    expect(post.status).toBe("PREVIEW");
    expect(post.text).toContain("Canton Fair");
    expect(post.text).toContain("$3 480");
    expect(post.text).toContain("viza bilan bog'liq xarajatlar kirmagan");
    expect(post.text.length).toBeLessThanOrEqual(1024);

    const funnel = await env.DB.prepare("SELECT code, content_item_id FROM funnels WHERE id = ?").bind(post.funnel_id).first<{ code: string; content_item_id: number }>();
    expect(funnel!.content_item_id).toBe(post.id);
    const preview = tg.calls.filter((c) => c.method === "sendMessage" && c.params.text === post.text).at(-1)!;
    const rows = (preview.params.reply_markup as { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] }).inline_keyboard;
    expect(rows[0]![0]).toEqual({ text: "✈️ Tayyor hisob-kitobni olish", url: `https://t.me/test_bot?start=${funnel!.code}` });
    expect(rows[1]!.map((b) => b.callback_data)).toEqual([`pp:p:${post.id}`, `pp:e:${post.id}`]);
  });

  it("publishing needs a connected channel; only a bot admin can connect one", async () => {
    const { app, tg, post } = await approvedResearch();
    await postUpdate(app, callbackUpdate(ADMIN_ID, `pp:p:${post.id}`));
    expect(String(tg.calls.at(-1)!.params.text)).toContain("Канал не подключён");
    expect((await postStatus(post.id))!.status).toBe("PREVIEW");

    await postUpdate(app, channelMember(CLIENT_ID, "administrator"));
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'channel'").first()).toBeNull();
    await postUpdate(app, channelMember(ADMIN_ID, "administrator"));
    expect(JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'channel'").first<{ value: string }>())!.value)).toEqual({
      id: CHANNEL_ID,
      title: "Xitoy sanoat bozori",
    });
  });

  it("publishes the exact text with the deep-link button, once, even on a double tap", async () => {
    const { app, tg, post } = await approvedResearch();
    await postUpdate(app, channelMember(ADMIN_ID, "administrator"));
    await postUpdate(app, callbackUpdate(ADMIN_ID, `pp:p:${post.id}`));
    await postUpdate(app, callbackUpdate(ADMIN_ID, `pp:p:${post.id}`));
    const published = tg.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === CHANNEL_ID);
    expect(published).toHaveLength(1);
    expect(published[0]!.params.text).toBe(post.text);
    expect(JSON.stringify(published[0]!.params.reply_markup)).toContain("start=");
    expect(JSON.stringify(published[0]!.params.reply_markup)).not.toContain("pp:");
    const status = await postStatus(post.id);
    expect(status!.status).toBe("PUBLISHED");
    expect(status!.channel_message_id).toEqual(expect.any(Number));
  });

  it("edit replaces the text (escaped) and shows a new preview; reject never publishes", async () => {
    const { app, tg, post } = await approvedResearch();
    await postUpdate(app, channelMember(ADMIN_ID, "administrator"));
    await postUpdate(app, callbackUpdate(ADMIN_ID, `pp:e:${post.id}`));
    await postUpdate(app, messageUpdate(ADMIN_ID, "Yangi matn <b>test</b>"));
    const edited = await env.DB.prepare("SELECT text FROM content_items WHERE id = ?").bind(post.id).first<{ text: string }>();
    expect(edited!.text).toBe("Yangi matn &lt;b&gt;test&lt;/b&gt;");
    expect(tg.calls.at(-1)!.params.text).toBe(edited!.text);

    // The next admin message is ordinary again.
    await postUpdate(app, messageUpdate(ADMIN_ID, "hello"));
    expect((await env.DB.prepare("SELECT text FROM content_items WHERE id = ?").bind(post.id).first<{ text: string }>())!.text).toBe(edited!.text);

    await postUpdate(app, callbackUpdate(ADMIN_ID, `pp:x:${post.id}`));
    await postUpdate(app, callbackUpdate(ADMIN_ID, `pp:p:${post.id}`));
    expect((await postStatus(post.id))!.status).toBe("REJECTED");
    expect(tg.calls.filter((c) => c.params.chat_id === CHANNEL_ID)).toHaveLength(0);
  });

  it("the lead magnet card can draft another post with its own campaign link; clients cannot", async () => {
    const { app, post } = await approvedResearch();
    const magnet = await env.DB.prepare("SELECT id FROM lead_magnets").first<{ id: number }>();
    await postUpdate(app, callbackUpdate(CLIENT_ID, `pp:n:${magnet!.id}`));
    await postUpdate(app, callbackUpdate(CLIENT_ID, `pp:p:${post.id}`));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM content_items").first<{ n: number }>())!.n).toBe(1);

    await postUpdate(app, callbackUpdate(ADMIN_ID, `pp:n:${magnet!.id}`));
    const posts = await env.DB.prepare("SELECT funnel_id FROM content_items ORDER BY id").all<{ funnel_id: number }>();
    expect(posts.results).toHaveLength(2);
    expect(new Set(posts.results.map((p) => p.funnel_id)).size).toBe(2);
  });

  it("losing admin rights in the channel disconnects it", async () => {
    const { app } = await approvedResearch();
    await postUpdate(app, channelMember(ADMIN_ID, "administrator"));
    await postUpdate(app, channelMember(ADMIN_ID, "left"));
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'channel'").first()).toBeNull();
  });
});
