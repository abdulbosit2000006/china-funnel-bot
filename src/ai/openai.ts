// Minimal OpenAI Responses API client. The provider sits behind AiClient so it can be swapped later.

export type AiStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";

export interface AiOutputItem {
  type: string;
  // web_search_call
  action?: { type?: string; query?: string; sources?: { url?: string }[] };
  // message
  content?: { type: string; text?: string; annotations?: { type: string; url?: string }[] }[];
}

export interface AiResponse {
  id: string;
  status: AiStatus;
  model?: string;
  output?: AiOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number } | null;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
}

export interface AiClient {
  model: string;
  create(body: Record<string, unknown>): Promise<AiResponse>;
  get(id: string): Promise<AiResponse>;
}

const API = "https://api.openai.com/v1/responses";

export function createOpenAI(apiKey: string, model: string, fetchUrl: typeof fetch = fetch): AiClient {
  async function send(url: string, init: RequestInit): Promise<AiResponse> {
    const res = await fetchUrl(url, {
      ...init,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => null)) as (AiResponse & { error?: { message?: string } }) | null;
    if (!res.ok || !body) throw new Error(`OpenAI ${res.status}: ${body?.error?.message ?? "no body"}`);
    return body;
  }
  return {
    model,
    create: (body) => send(API, { method: "POST", body: JSON.stringify({ model, ...body }) }),
    get: (id) => send(`${API}/${encodeURIComponent(id)}?include[]=web_search_call.action.sources`, { method: "GET" }),
  };
}

/** Final text of the answer (all output_text parts of message items). */
export function outputText(res: AiResponse): string {
  return (res.output ?? [])
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === "output_text" && c.text)
    .map((c) => c.text!)
    .join("\n");
}

export function webSearchCount(res: AiResponse): number {
  return (res.output ?? []).filter((o) => o.type === "web_search_call").length;
}

/** Same page for our purposes: no scheme, no www, no fragment, no trailing slash, lowercase host. */
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${u.search}`;
  } catch {
    return null;
  }
}

/** Every URL the model actually saw: web search sources and the citations in its answer. */
export function seenUrls(res: AiResponse): Set<string> {
  const urls = new Set<string>();
  const add = (u?: string) => {
    const n = u ? normalizeUrl(u) : null;
    if (n) urls.add(n);
  };
  for (const o of res.output ?? []) {
    if (o.type === "web_search_call") o.action?.sources?.forEach((s) => add(s.url));
    if (o.type === "message") o.content?.forEach((c) => c.annotations?.forEach((a) => a.type === "url_citation" && add(a.url)));
  }
  return urls;
}

/** True when the URL (or the same page without its query string, or its site root) was seen in the search. */
export function wasSeen(url: string, seen: Set<string>): boolean {
  const n = normalizeUrl(url);
  if (!n) return false;
  if (seen.has(n)) return true;
  const noQuery = n.split("?")[0]!;
  return [...seen].some((s) => s.split("?")[0] === noQuery);
}

/** The JSON object in a model answer, with or without a ```json fence. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("в ответе нет JSON-объекта");
  return JSON.parse(text.slice(start, end + 1));
}

// USD per 1M tokens (input, output), from the OpenAI pricing page; unknown models show tokens only.
const PRICES: Record<string, [number, number]> = {
  "gpt-6-astra": [10, 50],
  "gpt-6.1-sol": [2, 10],
  "gpt-6-luna": [0.1, 0.5],
};
const WEB_SEARCH_USD = 0.01; // $10 per 1000 calls

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number, searches: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (inputTokens * p[0] + outputTokens * p[1]) / 1_000_000 + searches * WEB_SEARCH_USD;
}
