// AI research: the bot finds exhibitions and builds research packages with OpenAI web search.
// Runs in OpenAI background mode; the cron starts and polls them. Nothing reaches clients without the usual approval.
import { getSetting, logAdminAction } from "../db";
import {
  estimateCostUsd,
  extractJson,
  outputText,
  seenUrls,
  wasSeen,
  webSearchCount,
  type AiClient,
  type AiResponse,
} from "../ai/openai";
import { discoverPrompt, repairPrompt, researchPrompt, type Candidate } from "../ai/prompts";
import { validateResearch } from "../pdf/exhibition";
import { log } from "../log";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { queueResearch } from "./research";

export const AI_CALLBACK_PREFIX = "ai:";
export const AI_LIMIT_SETTING = "ai.daily_limit";
const DEFAULT_DAILY_LIMIT = 10;
/** First answer plus one repair round when our validator finds problems. */
const MAX_ROUNDS = 2;
/** A background response that runs longer than this is given up. */
const MAX_RUN_MINUTES = 30;
const NO_KEY = "🔑 OpenAI не подключён: добавьте секрет OPENAI_API_KEY в Cloudflare (docs/setup-cloudflare.md, шаг «AI-research»).";

type Kind = "DISCOVER" | "RESEARCH";

interface RunRow {
  id: number;
  kind: Kind;
  status: string;
  request: string;
  chat_id: number;
  model: string | null;
  response_id: string | null;
  rounds: number;
  result: string | null;
  input_tokens: number;
  output_tokens: number;
  web_searches: number;
  created_at: string;
}

interface RunRequest {
  topic?: string | null;
  candidate?: Candidate;
  query?: string;
}

const today = (now: Date) => now.toISOString().slice(0, 10);

async function queueRun(
  tg: Telegram,
  db: D1Database,
  ai: AiClient | null,
  chatId: number,
  adminId: number,
  kind: Kind,
  request: RunRequest,
  now: Date,
): Promise<boolean> {
  if (!ai) {
    await sendMessage(tg, chatId, NO_KEY);
    return false;
  }
  const limit = (await getSetting<number>(db, AI_LIMIT_SETTING)) ?? DEFAULT_DAILY_LIMIT;
  const used = await db
    .prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE created_at >= ?")
    .bind(`${today(now)}T00:00:00.000Z`)
    .first<{ n: number }>();
  if ((used?.n ?? 0) >= limit) {
    await sendMessage(tg, chatId, `⛔ Дневной лимит AI-запросов (${limit}) исчерпан. Это защита бюджета OpenAI; завтра лимит обновится.`);
    return false;
  }
  const at = now.toISOString();
  const row = await db
    .prepare("INSERT INTO ai_runs (kind, request, chat_id, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(kind, JSON.stringify(request), chatId, ai.model, at, at)
    .first<{ id: number }>();
  await logAdminAction(db, adminId, `ai.${kind.toLowerCase()}`, at, { run: row!.id, ...request });
  return true;
}

/** /find [topic]: look for exhibitions worth a trip. */
export async function requestDiscovery(tg: Telegram, db: D1Database, ai: AiClient | null, chatId: number, adminId: number, topic: string | null, now: Date) {
  if (await queueRun(tg, db, ai, chatId, adminId, "DISCOVER", { topic }, now)) {
    await sendMessage(tg, chatId, `🔎 Ищу выставки${topic ? ` по теме «${escapeHtml(topic)}»` : ""}. Обычно это занимает 2–5 минут, пришлю список.`);
  }
}

/** /research <exhibition>: full research package → PDF for review. */
export async function requestResearch(tg: Telegram, db: D1Database, ai: AiClient | null, chatId: number, adminId: number, target: Candidate | string, now: Date) {
  const request: RunRequest = typeof target === "string" ? { query: target } : { candidate: target };
  if (await queueRun(tg, db, ai, chatId, adminId, "RESEARCH", request, now)) {
    const name = typeof target === "string" ? target : `${target.name} ${target.edition}`;
    await sendMessage(
      tg,
      chatId,
      `🔬 Собираю research: <b>${escapeHtml(name)}</b>. Даты, цены, источники, постер. Обычно 5–10 минут, потом придёт PDF на проверку.`,
    );
  }
}

export async function handleAiCallback(
  tg: Telegram,
  db: D1Database,
  ai: AiClient | null,
  callback: { id: string; fromId: number; chatId: number; messageId: number; data: string },
  now: Date,
): Promise<void> {
  const [action, rawRun, rawIdx] = callback.data.slice(AI_CALLBACK_PREFIX.length).split(":");
  await tg.call("answerCallbackQuery", { callback_query_id: callback.id });
  if (action === "d") return requestDiscovery(tg, db, ai, callback.chatId, callback.fromId, null, now);
  if (action !== "r") return;
  const run = await db.prepare("SELECT * FROM ai_runs WHERE id = ? AND kind = 'DISCOVER' AND status = 'DONE'").bind(Number(rawRun)).first<RunRow>();
  const candidate = run ? (JSON.parse(run.result!) as { candidates: Candidate[] }).candidates[Number(rawIdx)] : undefined;
  if (!candidate) return void (await sendMessage(tg, callback.chatId, "Этот список устарел, запустите поиск ещё раз."));
  await requestResearch(tg, db, ai, callback.chatId, callback.fromId, candidate, now);
}

// ---------- cron side ----------

const TOOLS = [{ type: "web_search", search_context_size: "medium" }];
const INCLUDE = ["web_search_call.action.sources"];

function firstPrompt(run: RunRow, now: Date, exclude: string[]): string {
  const req = JSON.parse(run.request) as RunRequest;
  if (run.kind === "DISCOVER") return discoverPrompt(today(now), req.topic ?? null, exclude);
  return researchPrompt(today(now), req.candidate ?? req.query ?? "");
}

async function update(db: D1Database, id: number, fields: Record<string, unknown>, now: Date) {
  const keys = Object.keys(fields);
  await db
    .prepare(`UPDATE ai_runs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map((k) => fields[k] ?? null), now.toISOString(), id)
    .run();
}

async function fail(tg: Telegram, db: D1Database, run: RunRow, error: string, now: Date, extra = "") {
  await update(db, run.id, { status: "FAILED", error }, now);
  await sendMessage(tg, run.chat_id, `⚠️ AI-${run.kind === "DISCOVER" ? "поиск" : "research"} не получился: ${escapeHtml(error)}${extra}`);
}

function costLine(run: RunRow): string {
  const usd = estimateCostUsd(run.model ?? "", run.input_tokens, run.output_tokens, run.web_searches);
  return `🤖 ${escapeHtml(run.model ?? "")} · поисков: ${run.web_searches} · токены ${run.input_tokens}/${run.output_tokens}${usd !== null ? ` · ≈$${usd.toFixed(2)}` : ""}`;
}

function validCandidates(raw: unknown): Candidate[] {
  const list = (raw as { candidates?: unknown })?.candidates;
  if (!Array.isArray(list)) return [];
  const str = (x: unknown) => typeof x === "string" && x.trim().length > 0;
  return list
    .filter((c): c is Candidate =>
      typeof c === "object" && c !== null &&
      ["name", "city", "dates", "official_site", "source_url"].every((k) => str((c as Record<string, unknown>)[k])) &&
      /^https?:\/\//.test((c as Candidate).official_site),
    )
    .slice(0, 8);
}

async function finishDiscovery(tg: Telegram, db: D1Database, run: RunRow, res: AiResponse, now: Date) {
  let candidates: Candidate[];
  try {
    candidates = validCandidates(extractJson(outputText(res)));
  } catch (error) {
    return fail(tg, db, run, `ответ не разобран (${error instanceof Error ? error.message : String(error)})`, now);
  }
  if (!candidates.length) return fail(tg, db, run, "подходящих выставок не нашлось", now);
  await update(db, run.id, { status: "DONE", result: JSON.stringify({ candidates }) }, now);
  const seen = seenUrls(res);
  const lines = candidates.map((c, i) => {
    const flag = wasSeen(c.source_url, seen) ? "" : " ⚠️ источник не из поиска, проверьте";
    return (
      `<b>${i + 1}. ${escapeHtml(c.name)} ${escapeHtml(c.edition ?? "")}</b>\n` +
      `📅 ${escapeHtml(c.dates)} · 📍 ${escapeHtml(c.city)}\n` +
      `🏷 ${escapeHtml(c.industry ?? "")}\n` +
      `${escapeHtml(c.why ?? "")}\n` +
      `<a href="${escapeHtml(c.source_url)}">источник</a>${flag}`
    );
  });
  const keyboard: InlineKeyboard = candidates.map((c, i) => [
    { text: `🔬 ${i + 1}. ${c.name} ${c.edition ?? ""}`.slice(0, 60), callback_data: `${AI_CALLBACK_PREFIX}r:${run.id}:${i}` },
  ]);
  await sendMessage(
    tg,
    run.chat_id,
    `🔎 <b>Нашёл выставки</b> (даты сверяйте по источнику):\n\n${lines.join("\n\n")}\n\nНажмите на выставку, чтобы собрать по ней research и PDF.\n\n${costLine(run)}`,
    keyboard,
  );
}

async function finishResearch(tg: Telegram, db: D1Database, ai: AiClient, run: RunRow, res: AiResponse, now: Date) {
  let raw: unknown;
  let errors: string[] = [];
  try {
    raw = extractJson(outputText(res));
    if (raw && typeof raw === "object") {
      // Facts we decide, not the model.
      Object.assign(raw, { research_date: today(now), currency: "USD", sample: false, reserve_pct: (raw as { reserve_pct?: unknown }).reserve_pct ?? 10 });
    }
    const result = validateResearch(raw);
    if (!result.ok) errors = result.errors;
    else {
      const seen = seenUrls(res);
      const unseen = result.data.sources.filter((s) => !wasSeen(s.url, seen));
      const cost = estimateCostUsd(run.model ?? "", run.input_tokens, run.output_tokens, run.web_searches) ?? 0;
      const warning = unseen.length
        ? `\n\n⚠️ Этих источников не было в результатах поиска, проверьте их до одобрения:\n${unseen.map((s) => `[${s.id}] ${escapeHtml(s.url)}`).join("\n")}`
        : "\n\n✅ Все источники взяты из результатов поиска.";
      const id = await queueResearch(
        tg,
        db,
        result.data,
        run.chat_id,
        now,
        `🤖 AI-research готов, PDF будет через 1–2 минуты. Проверьте цифры и источники перед одобрением.${warning}\n\n${costLine(run)}`,
        cost,
      );
      await update(db, run.id, { status: "DONE", result: JSON.stringify(result.data), research_item_id: id }, now);
      return;
    }
  } catch (error) {
    errors = [`JSON не разобран: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (run.rounds < MAX_ROUNDS) {
    const next = await ai.create({
      background: true,
      previous_response_id: run.response_id,
      input: [{ role: "user", content: repairPrompt(errors) }],
      tools: TOOLS,
      include: INCLUDE,
    });
    await update(db, run.id, { response_id: next.id, rounds: run.rounds + 1 }, now);
    log.info("ai.repair", { run: run.id, errors: errors.length });
    return;
  }
  const list = errors.slice(0, 10).map((e) => `• ${escapeHtml(e)}`).join("\n");
  await fail(tg, db, run, "research-пакет не прошёл проверку", now, `\n${list}\n\nМожно запустить ещё раз или поправить JSON вручную.`);
  const text = outputText(res);
  if (text) {
    const form = new FormData();
    form.set("chat_id", String(run.chat_id));
    form.set("document", new Blob([text], { type: "application/json" }), `ai-research-${run.id}.json`);
    await tg.upload("sendDocument", form).catch(() => undefined);
  }
}

/** One cron tick: poll running AI runs, start the next queued one. */
export async function runAiTick(deps: { tg: Telegram; db: D1Database; ai: AiClient | null }, now: Date): Promise<void> {
  const { tg, db, ai } = deps;
  if (!ai) return;
  const running = await db.prepare("SELECT * FROM ai_runs WHERE status = 'RUNNING' ORDER BY id").all<RunRow>();
  for (const run of running.results) {
    try {
      const res = await ai.get(run.response_id!);
      if (res.status === "queued" || res.status === "in_progress") {
        if (now.getTime() - Date.parse(run.created_at) > MAX_RUN_MINUTES * 60_000) await fail(tg, db, run, "слишком долго нет ответа", now);
        continue;
      }
      const counted: RunRow = {
        ...run,
        input_tokens: run.input_tokens + (res.usage?.input_tokens ?? 0),
        output_tokens: run.output_tokens + (res.usage?.output_tokens ?? 0),
        web_searches: run.web_searches + webSearchCount(res),
      };
      await update(db, run.id, { input_tokens: counted.input_tokens, output_tokens: counted.output_tokens, web_searches: counted.web_searches }, now);
      if (res.status !== "completed") {
        await fail(tg, db, counted, res.error?.message ?? res.incomplete_details?.reason ?? res.status, now);
        continue;
      }
      if (run.kind === "DISCOVER") await finishDiscovery(tg, db, counted, res, now);
      else await finishResearch(tg, db, ai, counted, res, now);
    } catch (error) {
      log.error("ai.poll_failed", error, { run: run.id });
      if (now.getTime() - Date.parse(run.created_at) > MAX_RUN_MINUTES * 60_000) {
        await fail(tg, db, run, error instanceof Error ? error.message : String(error), now);
      }
    }
  }

  // One run at a time keeps spending predictable.
  if (running.results.length) return;
  const next = await db.prepare("SELECT * FROM ai_runs WHERE status = 'QUEUED' ORDER BY id LIMIT 1").first<RunRow>();
  if (!next) return;
  const claimed = await db.prepare("UPDATE ai_runs SET status = 'RUNNING', updated_at = ? WHERE id = ? AND status = 'QUEUED'").bind(now.toISOString(), next.id).run();
  if (!claimed.meta.changes) return;
  try {
    const exclude = (await db.prepare("SELECT title FROM research_items WHERE status != 'REJECTED' ORDER BY id DESC LIMIT 30").all<{ title: string }>()).results.map((r) => r.title);
    const res = await ai.create({
      background: true,
      input: [{ role: "user", content: firstPrompt(next, now, exclude) }],
      tools: TOOLS,
      include: INCLUDE,
      metadata: { run_id: String(next.id), kind: next.kind },
    });
    await update(db, next.id, { response_id: res.id, rounds: 1 }, now);
  } catch (error) {
    await fail(tg, db, next, error instanceof Error ? error.message : String(error), now);
  }
}
