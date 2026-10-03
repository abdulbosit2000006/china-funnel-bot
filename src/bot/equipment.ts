// Monday rubric, step 2: before the business model is calculated, the founder sees real machines
// (photo, price, specs) and confirms one he can actually sell and deliver. Only then the PDF research starts.
import { extractJson, outputText, seenUrls, wasSeen } from "../ai/openai";
import { equipmentPrompt } from "../ai/prompts-content";
import { getSetting, logAdminAction, putSetting } from "../db";
import { escapeHtml, sendMessage } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { localTime } from "../time";
import { costLine, queueRun, updateRun, type RunHandler } from "./ai";
import { chosenCandidate, getSlot, type ContentCtx, type SlotRow } from "./plan";

export const EQUIPMENT_CALLBACK_PREFIX = "eq:";
const MANUAL_SETTING = (adminId: number) => `await.equipment.${adminId}`;

export interface EquipmentOption {
  name: string;
  manufacturer?: string;
  model?: string;
  page_url?: string;
  image_url?: string;
  price?: { value: number | null; currency?: string; basis?: string; source_date?: string; label?: string; note?: string };
  capacity?: string;
  power_kw?: number | null;
  area_m2?: number | null;
  operators?: number | null;
  specs?: string[];
  note?: string;
  /** The founder typed his own supplier's data. */
  manual?: boolean;
  description?: string;
  /** Set by the code: the page was not among the search results. */
  unseen?: boolean;
}

/** Asks the AI for 2–3 real machines for the chosen business idea. */
export async function startEquipmentSearch(ctx: ContentCtx, slot: SlotRow, chatId: number, exclude: string[] = []): Promise<boolean> {
  const idea = chosenCandidate(slot);
  if (!idea) return false;
  const at = ctx.now.toISOString();
  const claimed = await ctx.db
    .prepare("UPDATE plan_slots SET status = 'EQUIPMENT', updated_at = ? WHERE id = ? AND status IN ('PLANNED','WAITING_EQUIPMENT')")
    .bind(at, slot.id)
    .run();
  if (!claimed.meta.changes) return false;
  const run = await queueRun(ctx.tg, ctx.db, ctx.ai, chatId, 0, "EQUIPMENT", { idea, exclude }, ctx.now, { slotId: slot.id, subject: "MANUFACTURING" });
  if (run === null) {
    await ctx.db.prepare("UPDATE plan_slots SET status = ?, updated_at = ? WHERE id = ?").bind(slot.status, at, slot.id).run();
    return false;
  }
  await sendMessage(
    ctx.tg,
    chatId,
    `🔎 Понедельник «${escapeHtml(idea.topic)}»: ищу 2–3 реальные линии у китайских производителей (фото, цена, характеристики). Пришлю карточки, выберете ту, которую реально можете поставить.`,
  );
  return true;
}

function validOptions(raw: unknown, seen: Set<string>): EquipmentOption[] {
  const list = (raw as { options?: unknown })?.options;
  if (!Array.isArray(list)) return [];
  const https = (u: unknown) => typeof u === "string" && /^https?:\/\//.test(u);
  return list
    .filter((o): o is EquipmentOption => typeof o === "object" && o !== null && typeof (o as EquipmentOption).name === "string" && https((o as EquipmentOption).page_url))
    .slice(0, 3)
    .map((o) => ({ ...o, image_url: https(o.image_url) ? o.image_url : undefined, unseen: !wasSeen(o.page_url!, seen) }));
}

export function optionCaption(o: EquipmentOption, i: number): string {
  const price = o.price?.value
    ? `$${Math.round(o.price.value).toLocaleString("en-US").replace(/,/g, " ")} ${escapeHtml(o.price.basis ?? "")}${o.price.source_date ? `, ${escapeHtml(o.price.source_date)}` : ""} (${escapeHtml(o.price.label ?? "")})`
    : "цена не найдена";
  const facts = [
    o.capacity ? `⚙️ ${escapeHtml(o.capacity)}` : "",
    o.power_kw ? `⚡ ${o.power_kw} кВт` : "",
    o.area_m2 ? `📐 ${o.area_m2} м²` : "",
    o.operators ? `👷 ${o.operators} чел.` : "",
  ].filter(Boolean);
  const specs = (o.specs ?? []).slice(0, 5).map((s) => `• ${escapeHtml(String(s))}`);
  return [
    `<b>${i + 1}. ${escapeHtml(o.name)}</b>`,
    [o.manufacturer, o.model].filter(Boolean).map((x) => escapeHtml(String(x))).join(" · "),
    `💰 ${price}`,
    facts.join("  "),
    specs.join("\n"),
    o.note ? `<i>${escapeHtml(o.note)}</i>` : "",
    o.unseen ? "⚠️ страницы не было в результатах поиска, проверьте" : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1000);
}

export const equipmentHandler: RunHandler = {
  webSearch: true,
  async prompt(db, run, request, now) {
    const idea = request.idea as { topic: string; benefit?: string; angle?: string };
    return equipmentPrompt(now.toISOString().slice(0, 10), idea, (request.exclude as string[]) ?? []);
  },
  async finish(ctx, run, res) {
    const options = validOptions(extractJson(outputText(res)), seenUrls(res));
    if (!options.length) return ["нет ни одного варианта с name и page_url"];
    const slot = run.slot_id ? await getSlot(ctx.db, run.slot_id) : null;
    if (!slot) return;
    await ctx.db
      .prepare("UPDATE plan_slots SET equipment_options = ?, status = 'WAITING_EQUIPMENT', updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(options), ctx.now.toISOString(), slot.id)
      .run();
    await updateRun(ctx.db, run.id, { status: "DONE", result: JSON.stringify({ options: options.length }) }, ctx.now);
    const idea = chosenCandidate(slot);
    await sendMessage(ctx.tg, run.chat_id, `🏭 <b>Станки для понедельника</b>: ${escapeHtml(idea?.topic ?? "")}\nВыберите линию, которую реально можете продать и поставить. Цены с сайтов это ориентир, не коммерческое предложение.`);
    for (const [i, o] of options.entries()) {
      const keyboard: InlineKeyboard = [[{ text: "✅ Беру этот", callback_data: `${EQUIPMENT_CALLBACK_PREFIX}o:${slot.id}:${i}` }]];
      if (o.page_url) keyboard.push([{ text: "🔗 Страница товара", url: o.page_url }]);
      const caption = optionCaption(o, i);
      const markup = { inline_keyboard: keyboard };
      // Telegram fetches the photo itself; a broken link falls back to text.
      const sent = o.image_url
        ? await ctx.tg.call("sendPhoto", { chat_id: run.chat_id, photo: o.image_url, caption, parse_mode: "HTML", reply_markup: markup }).then(() => true, () => false)
        : false;
      if (!sent) await sendMessage(ctx.tg, run.chat_id, caption, keyboard);
    }
    await sendMessage(ctx.tg, run.chat_id, `Если ни один не подходит:\n\n${costLine(run)}`, [
      [{ text: "🔄 Другие поставщики", callback_data: `${EQUIPMENT_CALLBACK_PREFIX}r:${slot.id}` }],
      [{ text: "✏️ Свои данные (ваш поставщик)", callback_data: `${EQUIPMENT_CALLBACK_PREFIX}m:${slot.id}` }],
    ]);
  },
};

/** The machine is confirmed: the business model research starts with exactly this machine. */
async function confirmEquipment(ctx: ContentCtx, slot: SlotRow, equipment: EquipmentOption, chatId: number, adminId: number): Promise<void> {
  const at = ctx.now.toISOString();
  const today = localTime(ctx.now, ctx.timeZone).date;
  const autoDate = slot.slot_date > today ? slot.slot_date : today;
  const idea = chosenCandidate(slot);
  await ctx.db.prepare("UPDATE plan_slots SET equipment = ?, status = 'RESEARCHING', updated_at = ? WHERE id = ?").bind(JSON.stringify(equipment), at, slot.id).run();
  const run = await queueRun(
    ctx.tg,
    ctx.db,
    ctx.ai,
    chatId,
    adminId,
    "RESEARCH",
    { query: idea?.topic ?? equipment.name, equipment },
    ctx.now,
    { subject: "MANUFACTURING", autoDate, slotId: slot.id },
  );
  if (run === null) {
    await ctx.db.prepare("UPDATE plan_slots SET status = 'WAITING_EQUIPMENT', updated_at = ? WHERE id = ?").bind(at, slot.id).run();
    return;
  }
  await logAdminAction(ctx.db, adminId, "equipment.confirm", at, { slot: slot.id, name: equipment.name, manual: Boolean(equipment.manual) });
  const when = autoDate === today ? "сегодня, как только будет готов" : "в понедельник в 9:00";
  await sendMessage(ctx.tg, chatId, `✅ Станок подтверждён: <b>${escapeHtml(equipment.name)}</b>.\nСчитаю бизнес под ключ (CAPEX, расходы, себестоимость, окупаемость) и делаю PDF. Пост с PDF придёт ${when}.`);
}

export async function handleEquipmentCallback(ctx: ContentCtx, callback: { id: string; fromId: number; chatId: number; messageId: number; data: string }) {
  const [action, rawSlot, rawIdx] = callback.data.slice(EQUIPMENT_CALLBACK_PREFIX.length).split(":");
  const answer = (text?: string) => ctx.tg.call("answerCallbackQuery", { callback_query_id: callback.id, ...(text ? { text } : {}) });
  const slot = await getSlot(ctx.db, Number(rawSlot));
  if (!slot || slot.status !== "WAITING_EQUIPMENT") return void (await answer("Уже выбрано или устарело."));
  const options = JSON.parse(slot.equipment_options ?? "[]") as EquipmentOption[];
  if (action === "o") {
    const option = options[Number(rawIdx)];
    if (!option) return void (await answer());
    await answer("Принято.");
    return confirmEquipment(ctx, slot, option, callback.chatId, callback.fromId);
  }
  if (action === "r") {
    await answer();
    const exclude = options.map((o) => [o.manufacturer, o.model, o.name].filter(Boolean).join(" "));
    await startEquipmentSearch(ctx, slot, callback.chatId, exclude);
    return;
  }
  if (action === "m") {
    await putSetting(ctx.db, MANUAL_SETTING(callback.fromId), slot.id);
    await answer();
    await sendMessage(
      ctx.tg,
      callback.chatId,
      "✏️ Пришлите одним сообщением данные вашего поставщика: название линии, производитель и модель, цена и базис (EXW/FOB), производительность, мощность, площадь, сколько операторов, что входит в комплект.\n\nВажно: цена войдёт в PDF как цена линии, клиенты увидят её в расчёте. Если не хотите раскрывать цену поставщика, напишите ту цену, которую готовы показать клиенту. В сам пост цена не попадает; фото для поста можно заменить в превью.",
    );
    return;
  }
  await answer();
}

/** The founder's own supplier data. Returns true when the text was consumed. */
export async function handleEquipmentText(ctx: ContentCtx, adminId: number, chatId: number, text: string): Promise<boolean> {
  const slotId = await getSetting<number>(ctx.db, MANUAL_SETTING(adminId));
  if (!slotId) return false;
  await ctx.db.prepare("DELETE FROM settings WHERE key = ?").bind(MANUAL_SETTING(adminId)).run();
  const slot = await getSlot(ctx.db, slotId);
  if (!slot || slot.status !== "WAITING_EQUIPMENT") return false;
  const description = text.trim().slice(0, 2000);
  await confirmEquipment(ctx, slot, { name: description.split("\n")[0]!.slice(0, 120), manual: true, description }, chatId, adminId);
  return true;
}
