// OpenAI budget: a monthly cap (Abdul, 2026-10-03: $10 for the first month), a warning at 80%.
import { estimateCostUsd } from "../ai/openai";
import { getSetting, putSetting } from "../db";
import { sendMessage, type Telegram } from "../telegram/api";

export const BUDGET_SETTING = "ai.monthly_budget_usd";
export const DEFAULT_MONTHLY_BUDGET = 10;
const WARNED_SETTING = "ai.budget_warned";
const WARN_SHARE = 0.8;

export async function aiSpend(db: D1Database, since: string): Promise<{ usd: number; runs: number }> {
  const rows = await db
    .prepare("SELECT model, input_tokens, output_tokens, web_searches, extra_cost_usd FROM ai_runs WHERE created_at >= ?")
    .bind(since)
    .all<{ model: string | null; input_tokens: number; output_tokens: number; web_searches: number; extra_cost_usd: number }>();
  const usd = rows.results.reduce(
    (sum, r) => sum + (estimateCostUsd(r.model ?? "", r.input_tokens, r.output_tokens, r.web_searches) ?? 0) + (r.extra_cost_usd ?? 0),
    0,
  );
  return { usd, runs: rows.results.length };
}

const monthStart = (now: Date) => `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;

export async function monthlyBudget(db: D1Database): Promise<number> {
  return (await getSetting<number>(db, BUDGET_SETTING)) ?? DEFAULT_MONTHLY_BUDGET;
}

/** False when this month's spend reached the cap. Tells the admin once when 80% is passed. */
export async function budgetAllows(tg: Telegram, db: D1Database, chatId: number, now: Date): Promise<boolean> {
  const cap = await monthlyBudget(db);
  const { usd } = await aiSpend(db, monthStart(now));
  if (usd >= cap) {
    await sendMessage(
      tg,
      chatId,
      `⛔ Месячный бюджет OpenAI исчерпан: ≈$${usd.toFixed(2)} из $${cap}. Новые AI-запуски остановлены до 1-го числа. Поднять лимит: <code>/budget 15</code>.`,
    );
    return false;
  }
  const month = now.toISOString().slice(0, 7);
  if (usd >= cap * WARN_SHARE && (await getSetting<string>(db, WARNED_SETTING)) !== month) {
    await putSetting(db, WARNED_SETTING, month);
    await sendMessage(tg, chatId, `⚠️ Потрачено ≈$${usd.toFixed(2)} из месячного бюджета OpenAI $${cap}. На $${cap} бот остановит новые AI-запуски.`);
  }
  return true;
}

export async function monthSpend(db: D1Database, now: Date) {
  return aiSpend(db, monthStart(now));
}

/** /budget — this month's spend; /budget 15 — a new monthly cap in USD. */
export async function handleBudgetCommand(tg: Telegram, db: D1Database, chatId: number, arg: string, now: Date): Promise<void> {
  const value = Number(arg.trim().replace(",", "."));
  if (arg.trim() && (!Number.isFinite(value) || value < 1 || value > 500)) {
    return void (await sendMessage(tg, chatId, "Укажите сумму в долларах от 1 до 500, например <code>/budget 15</code>."));
  }
  if (arg.trim()) await putSetting(db, BUDGET_SETTING, value);
  const cap = await monthlyBudget(db);
  const { usd, runs } = await monthSpend(db, now);
  await sendMessage(
    tg,
    chatId,
    `💰 <b>OpenAI в этом месяце</b>: ≈$${usd.toFixed(2)} из $${cap} (${runs} запусков).\n` +
      `Это оценка бота по токенам и поискам; точная сумма в кабинете OpenAI.\n` +
      (arg.trim() ? "✅ Новый лимит сохранён." : "Изменить лимит: <code>/budget 15</code>"),
  );
}
