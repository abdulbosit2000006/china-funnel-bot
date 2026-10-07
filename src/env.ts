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
  OPENAI_API_KEY?: string; // optional: enables AI research
  OPENAI_MODEL?: string; // var, defaults to DEFAULT_AI_MODEL
  OPENAI_TRANSCRIBE_MODEL?: string; // var, defaults to DEFAULT_TRANSCRIBE_MODEL
  SYSTEM_STATUS?: string; // var: master switch, ACTIVE or PAUSED (see PAUSE_RESUME.md)
}

/**
 * Master switch. Only an explicit ACTIVE enables OpenAI and the scheduled AI work; anything else
 * (PAUSED, empty, a typo) counts as paused, so a broken setting never starts paid jobs.
 */
export function systemActive(env: Pick<Env, "SYSTEM_STATUS">): boolean {
  return (env.SYSTEM_STATUS ?? "").trim().toUpperCase() === "ACTIVE";
}

export function parseAdminIds(raw: string | undefined): Set<number> {
  const ids = new Set<number>();
  for (const part of (raw ?? "").split(",")) {
    const trimmed = part.trim();
    if (/^\d+$/.test(trimmed)) ids.add(Number(trimmed));
  }
  return ids;
}
