import { env } from "cloudflare:test";
import { createApp } from "../src/app";
import type { Telegram } from "../src/telegram/api";
import type { TgUpdate } from "../src/telegram/types";

export const ADMIN_ID = 1000;
export const CLIENT_ID = 2000;

export interface Call {
  method: string;
  params: Record<string, unknown>;
}

export function fakeTelegram(): Telegram & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (method === "getMe") return { username: "test_bot" } as T;
      return true as T;
    },
  };
}

export function makeApp(tg = fakeTelegram(), now = new Date("2026-10-03T12:00:00Z")) {
  return { app: createApp({ telegram: () => tg, now: () => now }), tg };
}

let nextUpdateId = 1;

export function messageUpdate(fromId: number, text: string, updateId = nextUpdateId++): TgUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: fromId, is_bot: false, first_name: `User${fromId}`, username: `user${fromId}` },
      chat: { id: fromId, type: "private" },
      date: 0,
      text,
    },
  };
}

export function callbackUpdate(fromId: number, data: string): TgUpdate {
  const id = nextUpdateId++;
  return {
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: fromId, is_bot: false, first_name: `User${fromId}` },
      message: { message_id: 1, chat: { id: fromId, type: "private" }, date: 0 },
      data,
    },
  };
}

export function postUpdate(app: ReturnType<typeof createApp>, update: TgUpdate, secret = "test-webhook-secret") {
  return app.fetch(
    new Request("https://bot.example.workers.dev/tg/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify(update),
    }),
    env,
  );
}
