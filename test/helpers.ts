import { env } from "cloudflare:test";
import { createApp } from "../src/app";
import type { PdfRenderer } from "../src/pdf/render";
import type { Telegram } from "../src/telegram/api";
import type { TgUpdate } from "../src/telegram/types";

export const ADMIN_ID = 1000;
export const CLIENT_ID = 2000;

export interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** Records every Bot API call. `files` maps file_path -> content served by downloadFile. */
export function fakeTelegram(files: Record<string, string> = {}): Telegram & { calls: Call[] } {
  const calls: Call[] = [];
  let uploads = 0;
  return {
    calls,
    async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (method === "getMe") return { username: "test_bot" } as T;
      if (method === "getFile") {
        const id = String(params.file_id);
        return { file_path: files[`documents/${id}.json`] !== undefined ? `documents/${id}.json` : `documents/${id}.pdf` } as T;
      }
      return true as T;
    },
    async downloadFile(filePath: string): Promise<ArrayBuffer> {
      calls.push({ method: "downloadFile", params: { filePath } });
      return new TextEncoder().encode(files[filePath] ?? `%PDF-1.4 fake ${filePath}`).buffer as ArrayBuffer;
    },
    async upload<T>(method: string, form: FormData): Promise<T> {
      const params: Record<string, unknown> = {};
      form.forEach((value, key) => (params[key] = typeof value === "string" ? value : `<file ${(value as File).name}>`));
      calls.push({ method, params });
      return { message_id: 900 + uploads, document: { file_id: `generated-${++uploads}` } } as T;
    },
  };
}

export function fakeRenderer() {
  const rendered: { html: string; footer: string }[] = [];
  const render: PdfRenderer = async (html, footer) => {
    rendered.push({ html, footer });
    return new TextEncoder().encode("%PDF-1.7 generated");
  };
  return Object.assign(render, { rendered });
}

export function makeApp(tg = fakeTelegram(), now = new Date("2026-10-03T12:00:00Z"), renderPdf = fakeRenderer()) {
  return { app: createApp({ telegram: () => tg, renderPdf: () => renderPdf, now: () => now }), tg, renderPdf };
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
