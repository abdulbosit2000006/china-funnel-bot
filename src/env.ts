export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  BROWSER: Fetcher;
  TIMEZONE: string;
  // Secrets (wrangler secret put / Cloudflare dashboard). Never committed.
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_API_TOKEN: string;
  ADMIN_TG_IDS: string; // comma-separated Telegram user ids
}

export function parseAdminIds(raw: string | undefined): Set<number> {
  const ids = new Set<number>();
  for (const part of (raw ?? "").split(",")) {
    const trimmed = part.trim();
    if (/^\d+$/.test(trimmed)) ids.add(Number(trimmed));
  }
  return ids;
}
