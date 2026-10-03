// Structured logs to Workers Logs. Bot tokens and long secrets are masked before printing.
const BOT_TOKEN = /\d{6,12}:[A-Za-z0-9_-]{30,}/g;
const BEARER = /(Bearer\s+)[A-Za-z0-9._-]{8,}/gi;

export function mask(text: string): string {
  return text.replace(BOT_TOKEN, "[bot-token]").replace(BEARER, "$1[secret]");
}

function emit(level: "info" | "error", event: string, fields: Record<string, unknown>): void {
  const line = mask(JSON.stringify({ level, event, ...fields }));
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields: Record<string, unknown> = {}) => emit("info", event, fields),
  error: (event: string, error: unknown, fields: Record<string, unknown> = {}) =>
    emit("error", event, { ...fields, error: error instanceof Error ? error.message : String(error) }),
};
