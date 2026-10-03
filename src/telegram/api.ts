import type { InlineKeyboard } from "./types";

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
  ) {
    super(`Telegram ${method} failed: ${code} ${description}`);
  }
}

/** Minimal Bot API client. Handlers depend on this interface so tests can record calls. */
export interface Telegram {
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
  /** Downloads a file by the file_path returned from getFile (Bot API limit: 20 MB). */
  downloadFile(filePath: string): Promise<ArrayBuffer>;
}

export function createTelegram(token: string, fetchImpl: typeof fetch = fetch): Telegram {
  return {
    async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      const body = (await response.json()) as { ok: boolean; result?: T; error_code?: number; description?: string };
      if (!body.ok) {
        throw new TelegramError(method, body.error_code ?? response.status, body.description ?? "unknown");
      }
      return body.result as T;
    },
    async downloadFile(filePath: string): Promise<ArrayBuffer> {
      const response = await fetchImpl(`https://api.telegram.org/file/bot${token}/${filePath}`);
      if (!response.ok) throw new TelegramError("downloadFile", response.status, response.statusText);
      return response.arrayBuffer();
    },
  };
}

export function sendMessage(
  tg: Telegram,
  chatId: number | string,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<unknown> {
  return tg.call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
