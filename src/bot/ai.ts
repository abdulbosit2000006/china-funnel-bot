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
import { repairPrompt, type Candidate } from "../ai/prompts";
import { log } from "../log";
import { escapeHtml, sendMessage, type Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { budgetAllows } from "./budget";
import { queueResearch } from "./research";
import { hasSubject, subjectSpec, type Subject } from "./subjects";

export const AI_CALLBACK_PREFIX = "ai:";
export const AI_LIMIT_SETTING = "ai.daily_limit";
const DEFAULT_DAILY_LIMIT = 10;
/** First answer plus one repair round when our validator finds problems. */
const MAX_ROUNDS = 2;
/** A background response that runs longer than this is given up. */
const MAX_RUN_MINUTES = 30;
const NO_KEY = "🔑 OpenAI не подключён: добавьте секрет OPENAI_API_KEY в Cloudflare (docs/setup-cloudflare.md, шаг «AI-research»).";

export type Kind = "DISCOVER" | "RESEARCH" | "PLAN" | "EQUIPMENT" | "DRAFT" | "CASE";

export interface RunRow {
  id: number;
  kind: Kind;
  subject: Subject;
  auto_date: string | null;
  slot_id: number | null;
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

export interface RunRequest {
  topic?: string | null;
  candidate?: Candidate;
  query?: string;
  /** Machine the founder confirmed for a business model (Monday rubric): the research must use it. */
  equipment?: unknown;
  /** Content System runs keep their own input here. */
  [key: string]: unknown;
}

export interface QueueOptions {
  subject?: Subject;
  autoDate?: string | null;
  slotId?: number | null;
}

const today = (now: Date) => now.toISOString().slice(0, 10);

export async function queueRun(
  tg: Telegram,
  db: D1Database,
  ai: AiClient | null,
  chatId: number,
  adminId: number,
  kind: Kind,
  request: RunRequest,
  now: Date,
  opts: QueueOptions = {},
): Promise<number | null> {
  const subject = opts.subject ?? "EXHIBITION";
  if (!ai) {
    await sendMessage(tg, chatId, NO_KEY);
    return null;
  }
  if (!hasSubject(subject)) {
    await sendMessage(tg, chatId, "Этот тип research ещё не подключён.");
    return null;
  }
  const limit = (await getSetting<number>(db, AI_LIMIT_SETTING)) ?? DEFAULT_DAILY_LIMIT;
  const used = await db
    .prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE created_at >= ? AND kind != 'TRANSCRIBE'")
    .bind(`${today(now)}T00:00:00.000Z`)
    .first<{ n: number }>();
  if ((used?.n ?? 0) >= limit) {
    await sendMessage(tg, chatId, `⛔ Дневной лимит AI-запросов (${limit}) исчерпан. Это защита бюджета OpenAI; завтра лимит обновится.`);
    return null;
  }
  if (!(await budgetAllows(tg, db, chatId, now))) return null;
  const at = now.toISOString();
  const row = await db
    .prepare("INSERT INTO ai_runs (kind, subject, auto_date, slot_id, request, chat_id, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(kind, subject, opts.autoDate ?? null, opts.slotId ?? null, JSON.stringify(request), chatId, ai.model, at, at)
    .first<{ id: number }>();
  await logAdminAction(db, adminId, `ai.${kind.toLowerCase()}`, at, { run: row!.id, subject, autoDate: opts.autoDate, slot: opts.slotId });
  return row!.id;
}

/** /find [topic] (exhibitions) or /ideas [topic] (business models): a list of candidates. */
export async function requestDiscovery(
  tg: Telegram,
  db: D1Database,
  ai: AiClient | null,
  chatId: number,
  adminId: number,
  topic: string | null,
  now: Date,
  subject: Subject = "EXHIBITION",
) {
  if (await queueRun(tg, db, ai, chatId, adminId, "DISCOVER", { topic }, now, { subject })) {
    const what = subject === "EXHIBITION" ? "выставки" : "производственные бизнес-идеи";
    await sendMessage(tg, chatId, `🔎 Ищу ${what}${topic ? ` по теме «${escapeHtml(topic)}»` : ""}. Обычно это занимает 2–5 минут, пришлю список.`);
  }
}

/** /research <exhibition> or /business <idea>: full research package → PDF for review. */
export async function requestResearch(
  tg: Telegram,
  db: D1Database,
  ai: AiClient | null,
  chatId: number,
  adminId: number,
  target: Candidate | string,
  now: Date,
  subject: Subject = "EXHIBITION",
) {
  const request: RunRequest = typeof target === "string" ? { query: target } : { candidate: target };
  if (await queueRun(tg, db, ai, chatId, adminId, "RESEARCH", request, now, { subject })) {
    const name = typeof target === "string" ? target : `${target.name} ${target.edition ?? ""}`.trim();
    const what = subject === "EXHIBITION" ? "Даты, цены, источники, постер" : "Линия, цены, рынок Узбекистана, расчёт бизнеса";
    await sendMessage(tg, chatId, `🔬 Собираю research: <b>${escapeHtml(name)}</b>. ${what}. Обычно 5–10 минут, потом придёт PDF на проверку.`);
  }
}

/** Autopilot: starts a discovery whose winner is researched and delivered in the morning without questions. */
export async function queueAutopilotRun(tg: Telegram, db: D1Database, ai: AiClient | null, chatId: number, subject: Subject, autoDate: string, now: Date): Promise<boolean> {
  return (await queueRun(tg, db, ai, chatId, 0, "DISCOVER", { topic: null }, now, { subject, autoDate })) !== null;
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
  if (action === "b") return requestDiscovery(tg, db, ai, callback.chatId, callback.fromId, null, now, "MANUFACTURING");
  if (action !== "r") return;
  const run = await db.prepare("SELECT * FROM ai_runs WHERE id = ? AND kind = 'DISCOVER' AND status = 'DONE'").bind(Number(rawRun)).first<RunRow>();
  const candidate = run ? (JSON.parse(run.result!) as { candidates: Candidate[] }).candidates[Number(rawIdx)] : undefined;
  if (!candidate) return void (await sendMessage(tg, callback.chatId, "Этот список устарел, запустите поиск ещё раз."));
  await requestResearch(tg, db, ai, callback.chatId, callback.fromId, candidate, now, run!.subject);
}

// ---------- cron side ----------

/** What a Content System run kind needs from the runner: its prompt and what to do with the answer. */
export interface RunHandler {
  prompt(db: D1Database, run: RunRow, request: RunRequest, now: Date): Promise<string>;
  /** false: no web search (e.g. a case from the founder's own notes). */
  webSearch: boolean;
  /** Returns the problems to send back as a repair round, or nothing when the answer was used. */
  finish(ctx: FinishContext, run: RunRow, res: AiResponse): Promise<string[] | void>;
}

export interface FinishContext {
  tg: Telegram;
  db: D1Database;
  ai: AiClient;
  now: Date;
  /** Admin ids, for runs that report to the owner. */
  admins: Set<number>;
  timeZone: string;
}

export type RunHandlers = Partial<Record<Kind, RunHandler>>;

export const TOOLS = [{ type: "web_search", search_context_size: "medium" }];
const INCLUDE = ["web_search_call.action.sources"];

function firstPrompt(run: RunRow, now: Date, exclude: string[]): string {
  const req = JSON.parse(run.request) as RunRequest;
  const spec = subjectSpec(run.subject);
  if (run.kind === "DISCOVER") return spec.discoverPrompt(today(now), req.topic ?? null, exclude);
  const prompt = spec.researchPrompt(today(now), req.candidate ?? req.query ?? "");
  if (!req.equipment) return prompt;
  return `${prompt}

ВАЖНО: владелец уже выбрал и подтвердил оборудование. Используй именно эту линию (производитель, модель, цена, характеристики и фото), не ищи другую; недостающее (доставка, таможня, рынок, сырьё, расходы) найди поиском:
${JSON.stringify(req.equipment)}`;
}

export async function updateRun(db: D1Database, id: number, fields: Record<string, unknown>, now: Date) {
  const keys = Object.keys(fields);
  await db
    .prepare(`UPDATE ai_runs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map((k) => fields[k] ?? null), now.toISOString(), id)
    .run();
}

export async function fail(tg: Telegram, db: D1Database, run: RunRow, error: string, now: Date, extra = "") {
  await updateRun(db, run.id, { status: "FAILED", error }, now);
  if (run.kind === "PLAN") {
    const planId = (JSON.parse(run.request) as { planId?: number }).planId;
    if (planId) await db.prepare("UPDATE content_plans SET status = 'FAILED' WHERE id = ? AND status = 'PLANNING'").bind(planId).run();
  }
  if (run.slot_id) {
    // The week view shows why this slot has no post.
    await db
      .prepare("UPDATE plan_slots SET status = 'FAILED', note = ?, updated_at = ? WHERE id = ? AND status NOT IN ('PUBLISHED','SKIPPED','REJECTED')")
      .bind(error.slice(0, 300), now.toISOString(), run.slot_id)
      .run();
  }
  const prefix = run.auto_date ? "⚠️ Автопилот: " : "⚠️ ";
  await tg.call("sendMessage", {
    chat_id: run.chat_id,
    text: `${prefix}AI-${KIND_NAMES[run.kind]} не получился: ${escapeHtml(error)}${extra}`,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    // Autopilot works at night: no sound.
    ...(run.auto_date ? { disable_notification: true } : {}),
  });
}

const KIND_NAMES: Record<Kind, string> = {
  DISCOVER: "поиск",
  RESEARCH: "research",
  PLAN: "план недели",
  EQUIPMENT: "поиск станка",
  DRAFT: "черновик поста",
  CASE: "черновик кейса",
};

export function costLine(run: RunRow): string {
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
      ["name", "official_site", "source_url"].every((k) => str((c as Record<string, unknown>)[k])) &&
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
  if (!candidates.length) return fail(tg, db, run, "подходящих вариантов не нашлось", now);
  await updateRun(db, run.id, { status: "DONE", result: JSON.stringify({ candidates }) }, now);
  if (run.auto_date) {
    // Autopilot picks the first candidate whose source the search actually returned.
    const seenNow = seenUrls(res);
    const pick = candidates.find((c) => wasSeen(c.source_url, seenNow)) ?? candidates[0]!;
    const at = now.toISOString();
    await db
      .prepare("INSERT INTO ai_runs (kind, subject, auto_date, slot_id, request, chat_id, model, created_at, updated_at) VALUES ('RESEARCH', ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(run.subject, run.auto_date, run.slot_id, JSON.stringify({ candidate: pick }), run.chat_id, run.model, at, at)
      .run();
    return;
  }
  const seen = seenUrls(res);
  const lines = candidates.map((c, i) => {
    const flag = wasSeen(c.source_url, seen) ? "" : " ⚠️ источник не из поиска, проверьте";
    return (
      `<b>${i + 1}. ${escapeHtml(c.name)} ${escapeHtml(c.edition ?? "")}</b>\n` +
      `${[c.dates, c.city].filter(Boolean).map((x) => escapeHtml(x)).join(" · ")}\n` +
      `🏷 ${escapeHtml(c.industry ?? "")}\n` +
      `${escapeHtml((c.why ?? "").slice(0, 300))}\n` +
      `<a href="${escapeHtml(c.source_url)}">источник</a>${flag}`
    );
  });
  const keyboard: InlineKeyboard = candidates.map((c, i) => [
    { text: `🔬 ${i + 1}. ${c.name} ${c.edition ?? ""}`.slice(0, 60), callback_data: `${AI_CALLBACK_PREFIX}r:${run.id}:${i}` },
  ]);
  await sendMessage(
    tg,
    run.chat_id,
    `🔎 <b>${run.subject === "EXHIBITION" ? "Нашёл выставки</b> (даты сверяйте по источнику)" : "Нашёл бизнес-идеи</b> (цены сверяйте по источнику)"}:\n\n${lines.join("\n\n")}\n\nНажмите на вариант, чтобы собрать по нему research и PDF.\n\n${costLine(run)}`,
    keyboard,
  );
}

/** Sends our validator's errors back to the model. False when the rounds are used up. */
async function repair(db: D1Database, ai: AiClient, run: RunRow, errors: string[], now: Date, webSearch: boolean): Promise<boolean> {
  if (run.rounds >= MAX_ROUNDS) return false;
  const next = await ai.create({
    background: true,
    previous_response_id: run.response_id,
    input: [{ role: "user", content: repairPrompt(errors) }],
    ...(webSearch ? { tools: TOOLS, include: INCLUDE } : {}),
  });
  await updateRun(db, run.id, { response_id: next.id, rounds: run.rounds + 1 }, now);
  log.info("ai.repair", { run: run.id, errors: errors.length });
  return true;
}

async function finishResearch(tg: Telegram, db: D1Database, ai: AiClient, run: RunRow, res: AiResponse, now: Date) {
  let raw: unknown;
  let errors: string[] = [];
  try {
    raw = extractJson(outputText(res));
    if (raw && typeof raw === "object") {
      // Facts we decide, not the model.
      Object.assign(raw, { research_date: today(now), currency: "USD", sample: false });
      if (run.subject === "EXHIBITION") Object.assign(raw, { reserve_pct: (raw as { reserve_pct?: unknown }).reserve_pct ?? 10 });
    }
    const spec = subjectSpec(run.subject);
    const result = spec.validate(raw);
    if (!result.ok) errors = result.errors;
    else {
      const seen = seenUrls(res);
      const unseen = result.data.sources.filter((s) => !wasSeen(s.url, seen));
      const cost = estimateCostUsd(run.model ?? "", run.input_tokens, run.output_tokens, run.web_searches) ?? 0;
      const warning = unseen.length
        ? `\n\n⚠️ Этих источников не было в результатах поиска, проверьте их до одобрения:\n${unseen.map((s) => `[${s.id}] ${escapeHtml(s.url)}`).join("\n")}`
        : "\n\n✅ Все источники взяты из результатов поиска.";
      const note = `${warning.trim()}\n\n${costLine(run)}`;
      const id = await queueResearch(tg, db, spec, result.data, run.chat_id, now, {
        intro: `🤖 AI-research готов, PDF будет через 1–2 минуты. Проверьте цифры и источники перед одобрением.\n\n${note}`,
        aiCostUsd: cost,
        autoDate: run.auto_date ?? undefined,
        slotId: run.slot_id ?? undefined,
      });
      await db.prepare("UPDATE research_items SET review_note = ? WHERE id = ?").bind(note, id).run();
      await updateRun(db, run.id, { status: "DONE", result: JSON.stringify(result.data), research_item_id: id }, now);
      if (run.slot_id) {
        await db.prepare("UPDATE plan_slots SET research_item_id = ?, status = 'RESEARCHING', updated_at = ? WHERE id = ?").bind(id, now.toISOString(), run.slot_id).run();
      }
      return;
    }
  } catch (error) {
    errors = [`JSON не разобран: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (await repair(db, ai, run, errors, now, true)) return;
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
export async function runAiTick(
  deps: { tg: Telegram; db: D1Database; ai: AiClient | null; admins?: Set<number>; timeZone?: string; handlers?: RunHandlers },
  now: Date,
): Promise<void> {
  const { tg, db, ai } = deps;
  const handlers = deps.handlers ?? {};
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
      await updateRun(db, run.id, { input_tokens: counted.input_tokens, output_tokens: counted.output_tokens, web_searches: counted.web_searches }, now);
      if (res.status !== "completed") {
        await fail(tg, db, counted, res.error?.message ?? res.incomplete_details?.reason ?? res.status, now);
        continue;
      }
      if (run.kind === "DISCOVER") await finishDiscovery(tg, db, counted, res, now);
      else if (run.kind === "RESEARCH") await finishResearch(tg, db, ai, counted, res, now);
      else await finishWithHandler(deps, handlers, counted, res, now);
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
    const handler = handlers[next.kind];
    let content: string;
    let webSearch = true;
    if (handler) {
      content = await handler.prompt(db, next, JSON.parse(next.request) as RunRequest, now);
      webSearch = handler.webSearch;
    } else {
      const exclude = (await db.prepare("SELECT title FROM research_items WHERE status != 'REJECTED' ORDER BY id DESC LIMIT 30").all<{ title: string }>()).results.map((r) => r.title);
      content = firstPrompt(next, now, exclude);
    }
    const res = await ai.create({
      background: true,
      input: [{ role: "user", content }],
      ...(webSearch ? { tools: TOOLS, include: INCLUDE } : {}),
      metadata: { run_id: String(next.id), kind: next.kind },
    });
    await updateRun(db, next.id, { response_id: res.id, rounds: 1 }, now);
  } catch (error) {
    await fail(tg, db, next, error instanceof Error ? error.message : String(error), now);
  }
}

async function finishWithHandler(
  deps: { tg: Telegram; db: D1Database; ai: AiClient | null; admins?: Set<number>; timeZone?: string },
  handlers: RunHandlers,
  run: RunRow,
  res: AiResponse,
  now: Date,
): Promise<void> {
  const handler = handlers[run.kind];
  if (!handler) return fail(deps.tg, deps.db, run, `нет обработчика для ${run.kind}`, now);
  let errors: string[] | void;
  try {
    errors = await handler.finish({ tg: deps.tg, db: deps.db, ai: deps.ai!, now, admins: deps.admins ?? new Set(), timeZone: deps.timeZone ?? "Asia/Tashkent" }, run, res);
  } catch (error) {
    errors = [`ответ не разобран: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (!errors || !errors.length) {
    // The handler marks the run DONE itself when it stores a result; make sure it does not stay RUNNING.
    await deps.db.prepare("UPDATE ai_runs SET status = 'DONE', updated_at = ? WHERE id = ? AND status = 'RUNNING'").bind(now.toISOString(), run.id).run();
    return;
  }
  if (await repair(deps.db, deps.ai!, run, errors, now, handler.webSearch)) return;
  const list = errors.slice(0, 8).map((e) => `• ${escapeHtml(e)}`).join("\n");
  await fail(deps.tg, deps.db, run, "ответ не прошёл проверку", now, `\n${list}`);
}
