import { env } from "cloudflare:test";
import type { AiClient, AiResponse } from "../src/ai/openai";
import { createApp } from "../src/app";
import type { ImageRenderer, PdfRenderer } from "../src/pdf/render";
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
      if (method === "sendMessage" || method === "sendPhoto") return { message_id: 5000 + calls.length } as T;
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
      const fileId = `generated-${++uploads}`;
      return { message_id: 900 + uploads, document: { file_id: fileId }, photo: [{ file_id: `${fileId}-small` }, { file_id: fileId }] } as T;
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

export function fakeImageRenderer() {
  const rendered: { html: string; width: number; height: number }[] = [];
  const render: ImageRenderer = async (html, width, height) => {
    rendered.push({ html, width, height });
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  };
  return Object.assign(render, { rendered });
}

export function makeApp(
  tg = fakeTelegram(),
  now = new Date("2026-10-03T12:00:00Z"),
  renderPdf = fakeRenderer(),
  renderImage: ImageRenderer = fakeImageRenderer(),
  fetchUrl: typeof fetch = async () => new Response("no network in tests", { status: 503 }),
  ai: AiClient | null = null,
) {
  return {
    app: createApp({ telegram: () => tg, renderPdf: () => renderPdf, renderImage: () => renderImage, now: () => now, fetchUrl, ai: () => ai }),
    tg,
    renderPdf,
  };
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

/** Fake AI provider: create() queues a response; set `answers[id]` to finish it. */
export function fakeAi() {
  const created: Record<string, unknown>[] = [];
  const answers: Record<string, AiResponse> = {};
  const transcribed: string[] = [];
  const client: AiClient = {
    model: "gpt-6.1-sol",
    async create(body) {
      created.push(body);
      return { id: `resp_${created.length}`, status: "queued" };
    },
    async get(id) {
      return answers[id] ?? { id, status: "in_progress" };
    },
    async transcribe(audio, filename) {
      transcribed.push(`${filename}:${audio.size}`);
      return "Mijoz Toshkentdan, Aziz aka, telefon +998 90 123 45 67. Zavod 18% arzonroq chiqdi, liniya 2 oyda keldi.";
    },
  };
  return Object.assign(client, { created, answers, transcribed });
}

export function aiAnswer(id: string, text: string, sourceUrls: string[] = []): AiResponse {
  return {
    id,
    status: "completed",
    usage: { input_tokens: 20_000, output_tokens: 5_000 },
    output: [
      { type: "web_search_call", action: { type: "search", sources: sourceUrls.map((url) => ({ url })) } },
      { type: "web_search_call", action: { type: "search" } },
      { type: "message", content: [{ type: "output_text", text, annotations: [] }] },
    ],
  };
}
