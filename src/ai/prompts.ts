// Prompts for AI research. The model finds facts and prices with sources; every total is computed by our code.
import { DATA_LABELS, SOURCE_TYPES } from "../pdf/exhibition";
import example from "./research-example.json";

export interface Candidate {
  name: string;
  edition: string;
  full_name: string;
  city: string;
  dates: string;
  industry: string;
  official_site: string;
  why: string;
  source_url: string;
}

const CONTEXT = `Ты research-аналитик консалтинговой компании abdulbosit_source. Её клиенты: предприниматели из Узбекистана, которые закупают в Китае сырьё, производственное оборудование, металл (горячекатаный рулон, катанка, проволока) и другие товары, а также ездят на китайские выставки любых отраслей (промышленность, стройка, еда, упаковка, текстиль, химия, электроника, сельское хозяйство и т.д.).

Главное правило: ноль выдумок. Каждый факт и каждая цена должны опираться на страницу, которую ты нашёл веб-поиском сейчас. Если не нашёл, честно пиши, что неизвестно. Не придумывай URL: указывай только адреса страниц из результатов поиска.`;

export function discoverPrompt(today: string, topic: string | null, exclude: string[]): string {
  return `${CONTEXT}

Сегодня ${today}. Найди веб-поиском 5–8 выставок в Китае, которые пройдут через 2–10 месяцев и реально полезны узбекским предпринимателям для закупок.
${topic ? `Тема от владельца: «${topic}». Подбирай выставки под неё.` : "Охвати разные отрасли, не только оборудование."}
${exclude.length ? `Уже разобраны, не предлагай повторно: ${exclude.join("; ")}.` : ""}

Критерии: крупная международная выставка, есть официальный сайт, даты на будущий год подтверждены или объявлены организатором, приезжают иностранные покупатели, отрасль востребована в Узбекистане.

Ответь ТОЛЬКО JSON-объектом без пояснений:
{"candidates":[{"name":"Canton Fair","edition":"2027 bahor","full_name":"China Import and Export Fair, 141-sessiya","city":"Guangzhou","dates":"15 aprel – 5 may 2027","industry":"ko'p tarmoqli","official_site":"https://...","why":"bir gapda, o'zbek tilida (lotin): nega o'zbek tadbirkoriga foydali","source_url":"https://... (страница, где ты увидел даты)"}]}
Поля name, city, dates, industry, why пиши на узбекском (латиница). Даты как на сайте организатора.`;
}

export function researchPrompt(today: string, target: Candidate | string): string {
  const what =
    typeof target === "string"
      ? `Выставка (запрос владельца): «${target}».`
      : `Выставка: ${target.name} ${target.edition} (${target.full_name}), ${target.city}, ${target.dates}. Официальный сайт: ${target.official_site}.`;
  return `${CONTEXT}

Сегодня ${today}. ${what}
Сделай research-пакет для PDF «Biznes safar hisob-kitobi» для поездки 2 человек из Ташкента на эту выставку.

Что найти веб-поиском:
1. Официальные данные: полное название, организатор, площадка, город, даты и этапы (phases) с категориями, условия для иностранных посетителей, регистрация и её срок (deadline), цифры прошлой выставки (stats: площадь, участники, посетители, страны) с годом и источником.
2. Официальный постер или баннер выставки (poster_url): прямая ссылка на JPG/PNG с сайта организатора. Если прямой ссылки на картинку нет, не заполняй поле.
3. Цены для поездки: авиабилет Ташкент (TAS) → город выставки и обратно в эти даты, отель рядом с площадкой на даты выставки, местный транспорт, eSIM, страховка, виза для граждан Узбекистана (режим и стоимость), регистрационный взнос посетителя.
4. Почему ехать узбекскому предпринимателю (relevance), программа по дням (program), чек-лист подготовки (checklist), практические советы (practical): оплата, связь, переводчик, транспорт.

Метки (label), строго:
- VERIFIED: значение прочитано на официальной/первичной странице.
- MARKET DATA: цена с агрегатора или рыночного сайта (авиабилеты, бронирование отелей).
- ESTIMATED: оценка на основе найденных данных.
- ASSUMPTION: разумное допущение без источника (source: null).
- UNKNOWN: не нашёл; для расходов тогда unit_price: null.
- CALCULATED не используй: все суммы считает наш код. Не пиши итоги, суммы и проценты от бюджета.
Допустимые метки: ${DATA_LABELS.join(", ")}. Типы источников: ${SOURCE_TYPES.join(", ")}.
Цены в USD. Если цена найдена в другой валюте, переведи по текущему курсу и укажи это в note.

Правила формата:
- Ответь ТОЛЬКО одним JSON-объектом в формате примера ниже, без пояснений.
- Все тексты для клиента (title, relevance, program, checklist, practical, note, categories, value) на узбекском языке, латиница, деловой стиль.
- slug: латиница-цифры-дефис, например "canton-fair-2027-spring".
- source во всех полях = id из массива sources, либо null. В sources только реальные страницы из поиска, retrieved_at = ${today}.
- scenario.people = 2, маршрут из Ташкента; ночи и дни под даты выставки (фокусный этап) плюс 1–2 дня на заводы.
- factors: [["people","kishi"]], [["rooms","xona"],["nights","kecha"]], [["people","kishi"],["days","kun"]] и т.п.
- reserve_pct: 10.
- Не пиши цены и пакеты наших услуг: блок про наши услуги добавляем сами.
- Значения в примере выдуманы для показа формата: никогда не копируй их, ищи свои.

Пример формата:
${JSON.stringify(example)}`;
}

export function repairPrompt(errors: string[]): string {
  return `Наш валидатор нашёл ошибки в твоём JSON:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nИсправь их и ответь ТОЛЬКО полным исправленным JSON-объектом. Не выдумывай данные: если значения нет, используй метку UNKNOWN и unit_price: null.`;
}
