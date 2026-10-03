// Prompts for the weekly content plan, equipment search, text posts and cases (Content System V1).
// Prompts are Russian; everything a client reads is Uzbek (Latin). Totals and decisions are made by our code.
import { SCORE_WEIGHTS, type Rubric } from "../content/model";

const CONTEXT = `Ты редактор и research-аналитик Telegram-канала консалтинговой компании abdulbosit_source («China Business Intelligence»). Аудитория: предприниматели из Узбекистана, которые закупают в Китае производственное оборудование, сырьё (включая металл: горячекатаный рулон, катанка, проволока) и другие товары, и ездят на китайские выставки любых отраслей.

Фильтр каждой темы: «BU TADBIRKORGA NIMA BERADI?» (что это даёт предпринимателю: деньги, время, меньше риска). Качество важнее количества.

Главное правило: ноль выдумок. Каждый факт и каждая цена опираются на страницу, которую ты нашёл веб-поиском сейчас. Не придумывай URL, кейсы, клиентов и цифры. Никогда не пиши цены и пакеты услуг компании.`;

const STYLE = `Стиль текста для канала:
- узбекский язык, латиница, живой деловой тон, как пишет опытный человек, а не ИИ;
- короткие абзацы, конкретика: модели, цифры с источником, названия городов и площадок;
- без шаблонных фраз («zamonaviy dunyoda», «noyob imkoniyat», «o'tkazib yubormang», «hech kimga sir emaski» и т.п.), без восклицательных цепочек, эмодзи умеренно (1 на абзац максимум);
- HTML только из тегов <b>, <i>, <u>, <s>, <code>, <a href="...">; никаких других тегов и markdown;
- первая строка: короткий жирный хук (<b>...</b>).`;

const SCORING = `Оцени каждую тему по критериям (целые числа, максимум в скобках): ${Object.entries(SCORE_WEIGHTS)
  .map(([k, v]) => `${k} (${v})`)
  .join(", ")}. relevance: нужно ли это узбекскому предпринимателю сейчас; value: что он получит; evidence: есть ли проверенные источники; specificity: конкретика; novelty: не банально и не повтор; actionability: ясно, что делать; lead_potential: приведёт ли к разговору о работе с Китаем; freshness: актуальность данных. Будь строгим: средняя тема получает 60–70, сильная 80+.`;

const CANDIDATE_FORMAT = `{"topic":"тема на узбекском","format":"…","goal":"LEAD_GENERATION|TRUST|RETENTION|ENGAGEMENT|AUTHORITY","benefit":"одна фраза на узбекском: что это даёт предпринимателю","hook":"первая строка поста на узбекском","angle":"чем тема интересна именно сейчас (по-русски, для владельца)","scores":{"relevance":0,"value":0,"evidence":0,"specificity":0,"novelty":0,"actionability":0,"lead_potential":0,"freshness":0},"source_urls":["https://… страницы из поиска"]}`;

export interface PlanInput {
  today: string;
  weekStart: string;
  mode: "NORMAL" | "EXHIBITION_SEASON";
  exhibitions: { name: string; starts_on: string | null; city: string | null }[];
  recentTopics: string[];
  rejected: string[];
  performance: string[];
}

export function planPrompt(p: PlanInput): string {
  const expo = p.exhibitions.length
    ? p.exhibitions.map((e) => `- ${e.name}${e.city ? `, ${e.city}` : ""}${e.starts_on ? `, ближайшее начало ${e.starts_on}` : ""}`).join("\n")
    : "(список пуст)";
  return `${CONTEXT}

Сегодня ${p.today}. Готовим план канала на неделю с понедельника ${p.weekStart}. Режим канала: ${p.mode === "EXHIBITION_SEASON" ? "СЕЗОН ВЫСТАВОК" : "обычный"}.

Рубрики недели:
1. BUSINESS_MODEL (понедельник, «1 STANOK — 1 BIZNES»): конкретный производственный бизнес на китайской линии для Узбекистана. format всегда "MANUFACTURING". Предложи 4–5 идей: продукт с местным спросом, линия доступна малому и среднему бизнесу (примерно до $300 000), у линии есть реальные производители в Китае. Владелец потом сам выберет одну и проверит, что может реально продать и поставить такую линию.
2. TRUST (среда): полезный пост доверия без PDF. format: MASLAHAT (лайфхак, фишка), XATO (типичная ошибка при работе с Китаем), CHECKLIST, KNOWLEDGE (как работать с китайцами: переговоры, культура, оплата, проверка поставщика, логистика). REAL_CASE не предлагай: кейсы берём только из базы владельца. Предложи 4 темы разных форматов.${p.mode === "EXHIBITION_SEASON" ? " Сейчас сезон выставок: 2 темы из 4 про подготовку к выставке (как выбрать стенды, как говорить с поставщиком на выставке, что проверить до поездки, как не переплатить)." : ""}
3. OPPORTUNITY (пятница, «Xitoydagi imkoniyat»): format EXHIBITION, TECHNOLOGY, MACHINE, RAW_MATERIAL, TREND, SUPPLY. Предложи 4 темы.
   - EXHIBITION только из списка выставок владельца (он может их организовать), в поле "exhibition" точное название из списка, и только если выставка начнётся не раньше чем через 8 недель. ${p.mode === "EXHIBITION_SEASON" ? "Сейчас сезон: минимум 2 темы из 4 должны быть выставками из списка (если по датам подходят)." : "Не больше одной выставки среди тем."}
   - RAW_MATERIAL: только если нашёл свежую цену с источником, датой, базисом поставки, валютой и единицей.
   - TREND / SUPPLY / TECHNOLOGY: только реальные изменения с источником (что изменилось, почему важно, что делать).

Список выставок владельца:
${expo}

Также:
- exhibition_dates: для каждой выставки из списка найди ближайшие даты на официальном сайте (если нашёл).
- similar_exhibitions: 0–3 выставки, похожие на выставки из списка по отрасли, которых в списке нет (владелец решит, добавлять ли).

${p.recentTopics.length ? `Темы, которые уже были за 90 дней (не повторяй без нового угла):\n${p.recentTopics.map((t) => `- ${t}`).join("\n")}\n` : ""}${p.rejected.length ? `Владелец недавно отклонил (учти причины):\n${p.rejected.map((t) => `- ${t}`).join("\n")}\n` : ""}${p.performance.length ? `Что сработало по лидам (данные бота):\n${p.performance.map((t) => `- ${t}`).join("\n")}\n` : ""}
${SCORING}

Ответь ТОЛЬКО JSON-объектом без пояснений:
{"slots":{"BUSINESS_MODEL":[${CANDIDATE_FORMAT}],"TRUST":[…],"OPPORTUNITY":[… для выставки ещё "exhibition":"название из списка"]},"exhibition_dates":[{"name":"как в списке","starts_on":"YYYY-MM-DD","ends_on":"YYYY-MM-DD","city":"…","official_site":"https://…","source_url":"https://…"}],"similar_exhibitions":[{"name":"…","city":"…","why":"по-русски, одна фраза","source_url":"https://…"}]}`;
}

export function equipmentPrompt(today: string, idea: { topic: string; benefit?: string; angle?: string }, exclude: string[]): string {
  return `${CONTEXT}

Сегодня ${today}. Владелец выбрал бизнес-идею: «${idea.topic}»${idea.benefit ? ` (${idea.benefit})` : ""}.
Перед расчётом бизнеса владелец должен убедиться, что может реально продать и поставить клиенту такую линию. Найди веб-поиском 2–3 реальные линии/станка от разных китайских производителей.

Для каждой: производитель, модель, страница товара (page_url), прямая ссылка на реальное фото этой модели (image_url, https JPG/PNG со страницы производителя или маркетплейса; если нет, не заполняй), цена (value в USD, basis: EXW/FOB/CIF и т.п., source_date, label: VERIFIED или MARKET DATA; если цены нет, value: null и label UNKNOWN), производительность с единицей, мощность кВт, площадь м², операторы, 3–6 ключевых характеристик (specs, по-русски, коротко).
${exclude.length ? `Эти варианты владелец уже видел, предложи другие: ${exclude.join("; ")}.` : ""}
Цена с маркетплейса это ориентир, а не коммерческое предложение. Если нашёл цену в юанях, переведи в USD и укажи исходную в note.

Ответь ТОЛЬКО JSON-объектом:
{"options":[{"name":"короткое название линии по-русски","manufacturer":"…","model":"…","page_url":"https://…","image_url":"https://….jpg","price":{"value":25000,"currency":"USD","basis":"FOB","source_date":"YYYY-MM-DD","label":"MARKET DATA","note":"…"},"capacity":"1500 шт/час","power_kw":45,"area_m2":200,"operators":4,"specs":["…"],"note":"по-русски: на что обратить внимание"}]}`;
}

const RUBRIC_RULES: Record<Rubric, string> = {
  BUSINESS_MODEL: "",
  TRUST: `Пост доверия (среда), без PDF. Конкретный совет, ошибка, чек-лист или знание о работе с китайцами, которое экономит деньги или время. Без рекламы услуг. CTA мягкий: сохранить (SAVE), переслать партнёру (SHARE), задать вопрос в боте (BOT_QUESTION) или без CTA (NONE). Можно добавить опрос (poll), если он уместен.`,
  OPPORTUNITY: `Пост «Xitoydagi imkoniyat» (пятница). Отвечает на три вопроса: что изменилось или что за возможность, почему это важно узбекскому бизнесу, что делать. Первая строка: <b>📣 Tadbirkorlar diqqatiga!</b>, потом заголовок. Для RAW_MATERIAL цену подавай как «Narx orientiri» с базисом, валютой, единицей, датой и источником; это рыночный ориентир, не наше предложение. CTA обычно BOT_QUESTION (задать вопрос в боте).`,
  INSIGHT: `Воскресный инсайт недели (лёгкий формат). Возьми одно-два реальных события этой недели (Китай, торговля с Узбекистаном, логистика, цены, правила) и объясни коротко, что это значит для предпринимателя. Можно закончить вопросом подписчикам или опросом (poll). Если за неделю не было ничего действительно полезного, не выдумывай: ответь {"skip":"почему пропускаем, по-русски"}.`,
  BREAKING: `Срочная новость вне расписания. Только если событие реально значимое (пошлины, визы, логистика, запреты, резкое движение цен, перенос выставки) и есть официальный или первичный источник. Структура: что изменилось → почему важно для узбекского бизнеса → что делать. Первая строка: <b>⚡️ Muhim yangilik</b>. Если источника нет или событие не значимое, ответь {"skip":"почему, по-русски"}.`,
};

export function draftPrompt(
  today: string,
  rubric: Rubric,
  input: { topic: string; format?: string; benefit?: string; hook?: string; angle?: string; source_urls?: string[]; comment?: string; questions?: string[] },
): string {
  return `${CONTEXT}

Сегодня ${today}. Напиши пост для канала.
Рубрика: ${rubric}. ${RUBRIC_RULES[rubric]}
Тема: «${input.topic}»${input.format ? `, формат ${input.format}` : ""}.
${input.benefit ? `Что это даёт предпринимателю: ${input.benefit}\n` : ""}${input.hook ? `Хук из плана: ${input.hook}\n` : ""}${input.angle ? `Угол: ${input.angle}\n` : ""}${input.source_urls?.length ? `Источники из плана (перепроверь поиском): ${input.source_urls.join(", ")}\n` : ""}${input.questions?.length ? `Вопросы, которые клиенты задавали боту на этой неделе (без имён, можно использовать как повод):\n${input.questions.map((q) => `- ${q}`).join("\n")}\n` : ""}${input.comment ? `Владелец просит исправить: «${input.comment}». Учти это в первую очередь.\n` : ""}
${STYLE}
- длина 600–2000 символов; ссылки на источники в текст не вставляй, они хранятся отдельно;
- каждое число, цену или факт из текста перечисли в claims с меткой и источником.

Метки claims: VERIFIED (официальная/первичная страница), MARKET DATA (маркетплейс, агрегатор, СМИ), ESTIMATED (оценка из найденных данных), ASSUMPTION (допущение), UNKNOWN. Для цены: is_price: true и обязательно basis, currency, unit, source_date.

Ответь ТОЛЬКО JSON-объектом:
{"text":"пост в HTML","format":"…","goal":"LEAD_GENERATION|TRUST|RETENTION|ENGAGEMENT|AUTHORITY","cta_type":"BOT_QUESTION|SAVE|SHARE|COMMENT|POLL|NONE","topic":"тема одной строкой","claims":[{"text":"…","label":"VERIFIED","source_url":"https://…","source_date":"YYYY-MM-DD","is_price":false}],"poll":null}
Опрос, если нужен: "poll":{"question":"на узбекском","options":["…","…"]}.`;
}

export function casePrompt(notes: string[]): string {
  return `${CONTEXT}

Владелец прислал заметки о реальной работе с клиентом (текст и расшифровки голосовых). Сделай из них пост-кейс для канала (рубрика доверия).

Заметки:
${notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}

Правила:
- используй только факты из заметок, ничего не добавляй и не приукрашивай;
- убери всё конфиденциальное: имена и фамилии клиентов, названия компаний клиентов и заводов-поставщиков, телефоны, ники, ссылки, точные цены, суммы контрактов, условия оплаты, личные данные. Обобщай: «toshkentlik mijozimiz», «Guangdongdagi zavod», «kutilganidan 18% arzonroq»;
- структура: ситуация → что сделали → результат → вывод для предпринимателя;
- ${STYLE.replace(/\n/g, " ")}
- длина 600–2000 символов.

Ответь ТОЛЬКО JSON-объектом:
{"text":"пост в HTML","topic":"тема одной строкой по-русски","redactions":["что убрал, по-русски"]}`;
}
