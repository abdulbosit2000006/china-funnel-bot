import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TgUpdate } from "../src/telegram/types";
import fixture from "./fixtures/exhibition-research.json";
import { visibleLength } from "../src/bot/posts";
import { ADMIN_ID, CLIENT_ID, callbackUpdate, fakeImageRenderer, fakeTelegram, makeApp, messageUpdate, postUpdate } from "./helpers";

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

const tick = (app: ReturnType<typeof makeApp>["app"], minute: number) =>
  app.scheduled({ scheduledTime: Date.parse(`2026-10-03T12:${String(minute).padStart(2, "0")}:00Z`) }, env);

/** Upload research → render PDF → approve → render cover; returns the app with a post preview waiting. */
async function approvedResearch(renderImage = fakeImageRenderer(), research: object = fixture, fetchUrl?: typeof fetch) {
  const tg = fakeTelegram({ "documents/r.json": JSON.stringify(research) });
  const { app } = makeApp(tg, undefined, undefined, renderImage, fetchUrl);
  await postUpdate(app, jsonUpload("r"));
  await tick(app, 1);
  const item = await env.DB.prepare("SELECT id FROM research_items").first<{ id: number }>();
  await postUpdate(app, callbackUpdate(ADMIN_ID, `rp:a:${item!.id}`));
  await tick(app, 2);
  const post = await env.DB.prepare("SELECT id, status, text, funnel_id, media FROM content_items").first<{
    id: number; status: string; text: string; funnel_id: number; media: string | null;
  }>();
  return { app, tg, post: post!, renderImage };
}

const postStatus = (id: number) =>
  env.DB.prepare("SELECT status, channel_message_id FROM content_items WHERE id = ?").bind(id).first<{ status: string; channel_message_id: number | null }>();

describe("channel post", () => {
  it("approving research drafts a post: bold hook, organizer figures, trip-cost question, CTA, branded cover and a deep-link button", async () => {
    const { tg, post, renderImage } = await approvedResearch();
    expect(post.status).toBe("PREVIEW");
    expect(post.text.startsWith("<b>📣 Tadbirkorlar diqqatiga!</b>")).toBe(true);
    expect(post.text).toContain("<b>Canton Fair 2027</b>");
    expect(post.text).toContain("2025-yil ko'rsatkichlari");
    // The price is only in the bot: the post asks the question and sends people there.
    expect(post.text).not.toMatch(/\$\s?\d/);
    expect(post.text).toContain("Bu safar 2 kishiga qancha turadi?");
    expect(post.text).toContain("safar hisobini oling");
    expect(post.text).not.toContain("Ro'yxatdan o'tish:"); // the deadline is UNKNOWN in the fixture
    expect(visibleLength(post.text)).toBeLessThanOrEqual(1024);

    expect(renderImage.rendered[0]).toMatchObject({ width: 1280, height: 720 });
    expect(renderImage.rendered[0]!.html).toContain("Canton Fair 2027");
    expect(renderImage.rendered[0]!.html).toContain("Narxi qancha?");
    expect(renderImage.rendered[0]!.html).not.toMatch(/\$\s?\d/);
    expect(JSON.parse(post.media!).r2_key).toBe(`posts/${post.id}.png`);
    expect(await env.FILES.get(`posts/${post.id}.png`)).not.toBeNull();

    const funnel = await env.DB.prepare("SELECT code, content_item_id FROM funnels WHERE id = ?").bind(post.funnel_id).first<{ code: string; content_item_id: number }>();
    expect(funnel!.content_item_id).toBe(post.id);
    const preview = tg.calls.filter((c) => c.method === "sendPhoto").at(-1)!;
    expect(preview.params.caption).toBe(post.text);
    const rows = (JSON.parse(String(preview.params.reply_markup)) as { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] }).inline_keyboard;
    expect(rows[0]![0]).toEqual({ text: "✈️ Safar hisobini olish", url: `https://t.me/test_bot?start=${funnel!.code}` });
    expect(rows[1]!.map((b) => b.callback_data)).toEqual([`pp:p:${post.id}`, `pp:e:${post.id}`]);
    expect(rows[2]!.map((b) => b.callback_data)).toEqual([`pp:i:${post.id}`, `pp:x:${post.id}`]);
  });

  it("uses the organizer's official poster as the photo when research gives one", async () => {
    const withPoster = structuredClone(fixture) as typeof fixture & { exhibition: { poster_url?: string } };
    withPoster.exhibition.poster_url = "https://www.cantonfair.org.cn/poster.jpg";
    const fetched: string[] = [];
    const fetchUrl = (async (url: string) => {
      fetched.push(url);
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
    }) as unknown as typeof fetch;
    const renderImage = fakeImageRenderer();
    const { tg, post } = await approvedResearch(renderImage, withPoster, fetchUrl);
    expect(fetched).toEqual(["https://www.cantonfair.org.cn/poster.jpg"]);
    expect(renderImage.rendered).toHaveLength(0);
    expect(JSON.parse(post.media!)).toMatchObject({ r2_key: `posts/${post.id}.jpg`, source: "poster" });
    expect(await env.FILES.get(`posts/${post.id}.jpg`)).not.toBeNull();
    expect(tg.calls.filter((c) => c.method === "sendPhoto").at(-1)!.params.photo).toBe(`<file post-${post.id}.jpg>`);
  });

  it("falls back to our cover when the poster is not an image, and tells the admin", async () => {
    const withPoster = structuredClone(fixture) as typeof fixture & { exhibition: { poster_url?: string } };
    withPoster.exhibition.poster_url = "https://example.com/page.html";
    const fetchUrl = (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const renderImage = fakeImageRenderer();
    const { tg, post } = await approvedResearch(renderImage, withPoster, fetchUrl);
    expect(renderImage.rendered).toHaveLength(1);
    expect(JSON.parse(post.media!)).toMatchObject({ r2_key: `posts/${post.id}.png`, source: "card" });
    expect(tg.calls.some((c) => String(c.params.text ?? "").includes("постер скачать не удалось"))).toBe(true);
  });

  it("the admin can replace the photo with any picture, e.g. the official poster", async () => {
    const { app, tg, post } = await approvedResearch();
    await postUpdate(app, callbackUpdate(ADMIN_ID, `pp:i:${post.id}`));
    const id = nextId++;
    await postUpdate(app, {
      update_id: id,
      message: {
        message_id: id,
        from: { id: ADMIN_ID, is_bot: false, first_name: "Admin" },
        chat: { id: ADMIN_ID, type: "private" },
        date: 0,
        photo: [
          { file_id: "poster-small", file_unique_id: "s", width: 320, height: 180 },
          { file_id: "poster-big", file_unique_id: "b", width: 1280, height: 720 },
        ],
      },
    });
    const media = JSON.parse((await env.DB.prepare("SELECT media FROM content_items WHERE id = ?").bind(post.id).first<{ media: string }>())!.media);
    expect(media).toEqual({ photo_file_id: "poster-big", r2_key: `posts/${post.id}-admin.jpg`, source: "admin" });
    expect(await env.FILES.get(media.r2_key)).not.toBeNull();
    expect(tg.calls.at(-1)).toMatchObject({ method: "sendPhoto", params: { photo: "poster-big", caption: post.text } });
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
    const published = tg.calls.filter((c) => c.params.chat_id === CHANNEL_ID);
    expect(published).toHaveLength(1);
    expect(published[0]!.method).toBe("sendPhoto");
    expect(published[0]!.params.photo).toBe(JSON.parse(post.media!).photo_file_id);
    expect(published[0]!.params.caption).toBe(post.text);
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
    expect(tg.calls.at(-1)).toMatchObject({ method: "sendPhoto", params: { caption: edited!.text } });

    // Too long for a caption: refused, still waiting for a shorter text.
    await postUpdate(app, callbackUpdate(ADMIN_ID, `pp:e:${post.id}`));
    await postUpdate(app, messageUpdate(ADMIN_ID, "x".repeat(1100)));
    expect(String(tg.calls.at(-1)!.params.text)).toContain("длиннее 1024");
    await postUpdate(app, messageUpdate(ADMIN_ID, "Yangi matn <b>test</b>"));

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
    await tick(app, 3);
    const posts = await env.DB.prepare("SELECT funnel_id FROM content_items ORDER BY id").all<{ funnel_id: number }>();
    expect(posts.results).toHaveLength(2);
    expect(new Set(posts.results.map((p) => p.funnel_id)).size).toBe(2);
  });

  it("if the cover cannot be rendered, the post still comes as a text preview after the last attempt", async () => {
    const failing = Object.assign(async () => {
      throw new Error("browser down");
    }, { rendered: [] }) as unknown as ReturnType<typeof fakeImageRenderer>;
    const { app, tg, post } = await approvedResearch(failing);
    expect(post.status).toBe("DRAFT");
    await tick(app, 5);
    await tick(app, 8);
    const after = await env.DB.prepare("SELECT status, media FROM content_items WHERE id = ?").bind(post.id).first();
    expect(after).toEqual({ status: "PREVIEW", media: null });
    expect(tg.calls.at(-1)).toMatchObject({ method: "sendMessage", params: { text: post.text } });
  });

  it("caption stays within 1024 characters even with long research texts", async () => {
    const long = structuredClone(fixture) as typeof fixture;
    long.exhibition.relevance = long.exhibition.relevance.map((r) => r.repeat(4));
    const { buildPostText } = await import("../src/bot/posts");
    const text = buildPostText({ title: "x" } as never, long as never);
    expect(visibleLength(text)).toBeLessThanOrEqual(1024);
    expect(text).not.toMatch(/\$\s?\d/);
    expect(text).toContain("safar hisobini oling");
  });

  it("losing admin rights in the channel disconnects it", async () => {
    const { app } = await approvedResearch();
    await postUpdate(app, channelMember(ADMIN_ID, "administrator"));
    await postUpdate(app, channelMember(ADMIN_ID, "left"));
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'channel'").first()).toBeNull();
  });
});
