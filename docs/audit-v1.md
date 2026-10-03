# CHINA BUSINESS RESEARCH & FUNNEL BOT — аудит и Vercel-архитектура (v1)

Дата: 2026-10-03. Режим: **только аудит**. Код, деплой, webhook, команды бота, канал, миграции и Vercel не трогались.

Метки достоверности в этом документе:
- **VERIFIED** — проверено сегодня по официальной странице (ссылка в разделе «Источники» в конце).
- **ESTIMATED** — моя оценка, источника нет.
- **UNKNOWN** — данных недостаточно.

---

## 0. Главный вывод аудита (коротко)

1. **Существующего «Telegram Assistant Bot» я не нашёл.** У вашего GitHub-подключения нет ни одного доступного репозитория (`list_repos` вернул пустой список, VERIFIED). В файлах проекта есть только код **AI Office Phase 1A**, собранный сегодня этим же проектом. Он никогда не был задеплоен: деплой ждал VPS, домен и токены (см. `docs/deploy.md` в коде). Значит, **«работающего production-бота, которого нельзя сломать», в этом проекте нет**. Если бот всё-таки существует где-то ещё (другой аккаунт GitHub, другой чат, чужой сервер) — это вопрос V1.
2. Поэтому аудит ниже выполнен по **коду Phase 1A как по единственной реальной базе**. Из него можно взять примерно 25–30% (AI-провайдер, конфиг, маскирование логов, проверка webhook-секрета, проверка админа, тесты). Ядро AI Office (task engine, approvals RED/YELLOW/GREEN, permissions агентов, worker, Docker) для этого MVP не нужно и не подходит под Vercel.
3. Vercel подходит для MVP, **но только на плане Pro ($20/мес)**: Hobby запрещает коммерческое использование и разрешает cron только раз в день (VERIFIED).
4. Рекомендуемая архитектура использует только GA-сервисы Vercel (Functions + Cron + Blob) и Neon Postgres. Бета-сервисы (Queues, Workflows для Python) не обязательны: фоновые задачи и follow-up идут через таблицу в БД и cron раз в минуту.
5. Самый важный продуктовый совет: **сначала проверить воронку на одном PDF, сделанном вручную**, а AI-research строить после. Воронка (пост → бот → PDF → follow-up → лид) дешёвая и быстрая; research и PDF-генерация — самая дорогая и рискованная часть.

---

## A. CURRENT BOT ARCHITECTURE — что есть сегодня

| Что | Где | Состояние |
|---|---|---|
| Репозитории GitHub | `list_repos` | **Нет ни одного** (VERIFIED) |
| Код AI Office Phase 1A | `/mnt/project-files/ai-office/code/ai-office/` + `ai-office.bundle` (2 коммита: `8db2302` архитектура, `c7ef715` Phase 1A) | Не задеплоен, не на GitHub |
| Архитектура AI Office | `ai-office-architecture-v1.md`, `-v2.md` | Заморожена, не удаляется |

Phase 1A — это Python-монолит:
- `main_app.py` — FastAPI: `/health` и `POST /tg/admin` (Telegram webhook);
- `main_worker.py` — **постоянно работающий процесс**, крутит цикл каждые 2 с: берёт задачи из таблицы `tasks`, запускает «агентов», рассылает карточки approval, истекает approvals;
- aiogram 3 — **только админ-бот** (allowlist), клиентского бота нет;
- PostgreSQL 16 в Docker + Alembic (миграция `0001`);
- Anthropic через абстракцию `AIProvider` со structured output;
- Docker Compose: db + migrate + app + worker + Caddy (HTTPS).

Клиентского бота, канала, PDF, research, изображений, планировщика follow-up — **нет вообще**.

## B. REUSABLE COMPONENTS — KEEP / REFACTOR / REMOVE / DEPRECATE

«REMOVE» здесь значит «не переносить в новый репозиторий». В репозитории AI Office ничего не удаляется.

| Компонент (Phase 1A) | Решение | Почему |
|---|---|---|
| `services/ai/provider.py` (AIProvider, FakeProvider, ModelTier, таблица цен) | **KEEP** | Простая абстракция, провайдер меняется в одном месте. Цены в коде совпадают с сегодняшним прайсом Anthropic (VERIFIED). |
| `services/ai/anthropic_provider.py` | **REFACTOR** | Добавить инструменты `web_search` / `web_fetch` и разбор citations (URL источников). Сейчас умеет только JSON без инструментов. |
| `services/ai/service.py` (бюджет, валидация Pydantic, 1 повтор, учёт стоимости) | **REFACTOR** | Логика нужна, но привязана к `tasks`/`ai_runs` AI Office. Упростить: учёт стоимости в `research_items`/`ai_usage`. |
| `services/ai/prompts.py` + `prompts/<agent>/*.v1.md` | **KEEP (механизм)** / REMOVE (демо-промпты) | Версионирование промптов файлами полезно. Демо-промпты про «анализ запроса» не нужны. |
| `config.py` (pydantic-settings, SecretStr) | **KEEP + REFACTOR** | Секреты только из env — правильно. Убрать `admin_bot_mode=polling`, `worker_poll_seconds`, Docker-специфику. |
| `core/logging.py` (маскирование токенов, ключей, телефонов в логах) | **KEEP** | Работает и на Vercel (логи в stdout). |
| Проверка `X-Telegram-Bot-Api-Secret-Token` через `compare_digest` в `main_app.py` | **KEEP** | Ровно то, что нужно для webhook. |
| `set_webhook` в lifespan FastAPI | **REMOVE** | В serverless lifespan запускается на каждом холодном старте. Webhook ставится один раз отдельным скриптом. |
| Polling-ветка (`dp.start_polling`) | **REMOVE** | Запрещено требованиями. |
| `interfaces/admin_bot/auth.py` (allowlist-middleware) | **REFACTOR** | Сейчас «кто не админ — отказ». Нужен роутинг: админ → админ-меню, остальные → клиентский поток. |
| `interfaces/admin_bot/cards.py`, `handlers.py` | **REFACTOR** (идея карточек с кнопками APPROVE/EDIT/REJECT) | Пригодится для превью постов и research. |
| `core/identity` (persons, telegram_identities, admin_users) | **REFACTOR** | Слить в одну таблицу `users` + список админов из env. |
| `core/audit` (`audit_log`) | **REFACTOR → `admin_actions`** | Идея та же, схема проще. |
| `core/tasks/*` (task engine, зависимости, FOR UPDATE SKIP LOCKED) | **DEPRECATE** | Для MVP слишком тяжело. Нужна лишь маленькая таблица `jobs`. Приём `SKIP LOCKED` переиспользуем в ней. |
| `core/approvals` (GREEN/YELLOW/RED, роли, истечение) | **DEPRECATE** | Один админ, одно действие «approve». Достаточно статуса у content/lead_magnet. |
| `core/permissions/policy.py` (политика прав агентов) | **DEPRECATE** | Агентов нет. |
| `agents/*` (base, registry, demo) | **DEPRECATE** | Один логический AI с несколькими workflow вместо агентов. |
| `main_worker.py` | **REMOVE** | Постоянный процесс, запрещён. Заменяется cron-эндпоинтом. |
| `Dockerfile`, `docker-compose.yml`, `deploy/Caddyfile`, `scripts/backup.sh`, `restore.sh` | **REMOVE** | Vercel и Neon делают это сами (у Neon есть восстановление на момент времени). |
| Alembic | **KEEP** | Миграции запускаются в CI/вручную против Neon, не в рантайме. Миграцию `0001` не переносим — новая схема. |
| CI (`ruff`, `pytest`, `gitleaks`) | **KEEP** | Тесты с Postgres-сервисом в GitHub Actions подходят и для Neon-схемы. |
| Тестовые хелперы (`tests/conftest.py`, FakeProvider) | **KEEP** | Тесты без оплаты AI. |
| `docs/brief*.md`, `architecture-v*.md` | **KEEP в репозитории AI Office** | Не удалять, заморожено. В новый репозиторий — ссылка. |

## C. CURRENT AI/API INTEGRATION

- Провайдер: Anthropic, SDK `anthropic>=0.60`, асинхронный клиент, таймаут 120 с, 2 повтора.
- Ключ: переменная окружения `ANTHROPIC_API_KEY` (SecretStr). Без ключа — офлайн-режим с FakeProvider.
- Модели (`provider.py`): CHEAP = `claude-haiku-4-5`, STANDARD = `claude-sonnet-5-5`, STRONG = `claude-opus-5-5`. Цены в коде $1/$5, $2/$10, $4/$20 за 1M токенов — совпадают с официальными (VERIFIED). Batch API даёт −50% (VERIFIED), полезно для фонового research.
- Structured output: `output_config.format = json_schema`, ответ валидируется Pydantic, при ошибке один повтор, иначе ошибка (никогда не «угадывает»).
- Месячный бюджет: `AI_MONTHLY_BUDGET_USD` (по умолчанию 50).
- **Web research: отсутствует.** Модель отвечает только из памяти — по вашим же правилам это не research.

## D. CURRENT TELEGRAM IMPLEMENTATION

| Вопрос | Ответ |
|---|---|
| Polling или webhook? | Оба. Локально polling, на сервере webhook (`/tg/admin`) с secret token. |
| Admin? | Да, только админ-бот: `/status`, `/tasks`, `/demo`, карточки approval. Чужим — «Доступ запрещён». |
| Client flow? | Нет. |
| Channel? | Нет публикации в канал. |
| Deep links / campaigns? | Нет. |
| FSM / диалоги? | Нет. По умолчанию aiogram хранит состояние в памяти, что в serverless не работает — для квалификации нужно состояние в БД. |
| Дедупликация `update_id`? | Нет. Telegram повторяет запрос при не-2xx ответе (VERIFIED), значит дубликаты возможны. |

## E. CURRENT DATABASE / STORAGE

- PostgreSQL 16 в Docker-контейнере на VPS (не managed). Таблицы: `persons`, `telegram_identities`, `admin_users`, `tasks`, `task_dependencies`, `approvals`, `ai_runs`, `audit_log`, `events`, `agent_state`, `settings`.
- Подключение: SQLAlchemy async + `asyncpg`, пул соединений процесса.
- Файлового хранилища нет.
- **Managed БД не используется**, поэтому миграции «без причины» не происходит: переходим на Neon с новой схемой. Данных для переноса нет.

## F. CURRENT DEPLOYMENT MODEL — почему не подходит Vercel

| Требует Phase 1A | Разрешено на Vercel? |
|---|---|
| Постоянный `main_worker` (цикл раз в 2 с) | Нет. Функции живут не дольше 300 с (Hobby) / 800 с (Pro) (VERIFIED). |
| Polling | Нет (нужен постоянный процесс). |
| Postgres в Docker | Нет. Нужна managed БД. |
| Docker Compose + Caddy | Нет. HTTPS и маршрутизацию даёт Vercel. |
| `crontab` для бэкапов | Нет. Бэкапы делает Neon. |
| `set_webhook` при каждом старте | Работает, но неправильно: на холодных стартах будут лишние вызовы. |
| Пул соединений `asyncpg` в процессе | Нужно менять: pooled-строка Neon + `NullPool` + `statement_cache_size=0` (иначе ошибки prepared statements через PgBouncer). ESTIMATED, проверим на Phase 1. |

Что переносится без изменений: FastAPI как ASGI-приложение. Vercel запускает FastAPI нативно, Python 3.12–3.14 (VERIFIED).

---

## G. VERCEL-NATIVE TARGET ARCHITECTURE

### G.1 Схема

```
Telegram ──HTTPS webhook──▶ Vercel Function  POST /api/tg/webhook
                              │  1) проверка secret token
                              │  2) INSERT update_id (дедуп)
                              │  3) быстрые действия: /start, выдача PDF по file_id,
                              │     кнопки, ответы квалификации, админ-меню
                              │  4) долгая работа → INSERT в jobs (status=queued)
                              ▼
                         Neon Postgres  (источник правды: users, leads, jobs, followups…)
                              ▲
Vercel Cron (каждую минуту) ──▶ Vercel Function  GET /api/cron/tick   (maxDuration 300–800 с)
                              │  • забирает due followups → отправляет
                              │  • забирает 1–N jobs (research step, PDF render, publish)
                              │  • помечает устаревший research (NEEDS_REVIEW)
                              ▼
            Anthropic API (+ web_search / web_fetch)   Vercel Blob (PDF-оригиналы, картинки)
                              │
                              ▼
                     Telegram Bot API (sendMessage / sendDocument / публикация в канал)
```

### G.2 Ключевые решения

| Решение | Выбор | Почему |
|---|---|---|
| Язык | **Python 3.12 + FastAPI** (по умолчанию) | Переиспользуем AI-провайдер, конфиг, тесты. Vercel поддерживает FastAPI нативно (VERIFIED). Альтернатива — TypeScript/Next.js: у Vercel Workflows там зрелый SDK, а Python-SDK Workflows в beta (VERIFIED). Для MVP это не нужно. |
| Telegram-библиотека | aiogram 3 только как типы + клиент Bot API, **без Dispatcher-polling** и без памяти FSM | Состояние диалога в БД (`users.state`). |
| Один бот | Клиенты и админ в одном боте, админ определяется по `ADMIN_TG_IDS` из env | Как в требованиях (§37). |
| План Vercel | **Pro** | Hobby — только некоммерческое использование и cron раз в день ±59 мин (VERIFIED). |
| Регион функций | `fra1` (Франкфурт) + Neon `aws-eu-central-1` | Ближе к Узбекистану и к серверам Telegram в Европе; функция и БД в одном регионе. ESTIMATED. |
| Фоновая работа | Таблица `jobs` + **Vercel Cron раз в минуту** | GA, без beta, переживает сбои: задача в БД, а не в памяти. Задержка до ~1 мин — для админского research это нормально. |
| Долгий research | Разбит на шаги ≤ 5 мин; каждый шаг — отдельный вызов cron | Укладываемся в 300 с; на Pro можно до 800 с (VERIFIED). |
| Альтернатива (позже) | Vercel Queues (delay до 7 дней, Python SDK) или Workflows (`sleep("2 hours")`) | Обе в **beta** (VERIFIED). Подключим, если cron-подход упрётся в лимиты. |
| Секреты | Vercel Environment Variables (Production/Preview отдельно) | Не в git. |
| Staging | Отдельный тестовый бот + Preview-деплой Vercel + Neon branch | Production-бот не трогаем до готовности. |

### G.3 Эндпоинты

| Путь | Кто вызывает | Что делает |
|---|---|---|
| `POST /api/tg/webhook` | Telegram | Все апдейты. Ответ за < 1–2 с. |
| `GET /api/cron/tick` | Vercel Cron, раз в минуту | Follow-ups, jobs, проверка свежести. Защищён `CRON_SECRET` (заголовок Authorization). |
| `GET /api/health` | вы / мониторинг | Проверка БД. |
| `POST /api/admin/set-webhook` (или CLI-скрипт) | вы, один раз | `setWebhook` с secret token и `allowed_updates`. |

---

## H. DATABASE DESIGN — минимальная схема MVP

Postgres (Neon). Деньги — `numeric`, время — `timestamptz` (UTC), гибкие данные research — `jsonb`. 13 таблиц: 11 из требований + `jobs` и `processed_updates` (без них serverless не работает надёжно). Шаблоны текстов лежат в `settings`, отдельная таблица не нужна.

```
users
  id, tg_user_id UNIQUE, username, first_name, language (uz|ru),
  first_source, first_campaign_id, created_at, last_seen_at,
  is_blocked_bot bool, opted_out bool,
  state text NULL, state_data jsonb      -- текущий шаг квалификации (вместо FSM в памяти)

sources                                   -- каждый URL, который реально открыл research
  id, url, title, publisher, source_type (PRIMARY|OFFICIAL|MANUFACTURER|GOV_INDUSTRY|SECONDARY|MARKETPLACE),
  language, source_date NULL, retrieved_at, content_hash, snippet

research_items                            -- один research-пакет (выставка / линия / рынок)
  id, kind (EXHIBITION|MANUFACTURING|MARKET|MACHINERY|RAW_MATERIAL),
  title, status (DRAFT|IN_REVIEW|ACTIVE|NEEDS_REVIEW|OUTDATED|REJECTED),
  research_date, valid_until NULL,
  data jsonb       -- поля вида {value, unit, classification, source_ids[], note}
  calc jsonb       -- результат движка расчётов (вход → формула → результат)
  ai_cost_usd, created_at, updated_at, approved_at, approved_by

research_item_sources (research_item_id, source_id, field_path)   -- какой факт из какого источника

lead_magnets
  id, slug ("paper-cup"), version (1,2…), UNIQUE(slug, version),
  type (EXHIBITION_GUIDE|MANUFACTURING_MODEL|MACHINERY_GUIDE|RAW_MATERIAL_GUIDE),
  title, language, research_item_id, research_date,
  status (DRAFT|APPROVED|ACTIVE|OUTDATED|ARCHIVED),
  blob_url (приватный оригинал), tg_file_id (для мгновенной выдачи), file_sha256,
  intro_template_key, cta_template_key, created_at, updated_at

content_items                             -- посты канала
  id, lead_magnet_id NULL, funnel_id NULL, text, media jsonb,
  status (DRAFT|PREVIEW|APPROVED|PUBLISHED|REJECTED),
  channel_message_id NULL, published_at NULL, created_at

funnels                                   -- кампания = deep-link payload
  id, code UNIQUE ("cf26_p1", ≤ 64 симв. [A-Za-z0-9_-]), kind (EXHIBITION|MANUFACTURING|…),
  lead_magnet_slug, content_item_id NULL, active bool, created_at

leads                                     -- одна строка на человека (не на PDF)
  id, user_id UNIQUE, stage (VISITOR|LEAD|ENGAGED|INTERESTED|QUALIFIED|CONTACTED|NOT_QUALIFIED),
  score int, hot_signal_at NULL, last_funnel_id, answers jsonb,
  notified_admin_at NULL, contacted_at NULL, updated_at

funnel_events                             -- история человека по воронке (что он делал)
  id, user_id, funnel_id NULL, lead_magnet_id NULL,
  type (START|PDF_SENT|CTA_CLICK|FOLLOWUP_SENT|FOLLOWUP_REPLY|INTERESTED|QUESTION|NOT_NOW|
        QUAL_ANSWER|QUALIFIED|CONTACTED|NOT_QUALIFIED|OPT_OUT),
  payload jsonb, created_at

followups
  id, user_id, lead_magnet_id, funnel_id, due_at, status (PENDING|SENT|CANCELLED|FAILED),
  sent_at NULL, cancel_reason NULL, UNIQUE(user_id, lead_magnet_id)   -- максимум один на PDF

admin_actions                             -- аудит действий админа
  id, admin_tg_id, action, object_type, object_id, details jsonb, created_at

analytics_events                          -- сырые технические события (для статистики и отладки)
  id, name, user_id NULL, funnel_id NULL, props jsonb, created_at

jobs                                      -- очередь фоновой работы (вместо worker)
  id, kind (RESEARCH_STEP|RENDER_PDF|PUBLISH_POST|DISCOVER_CANDIDATES…), payload jsonb,
  status (QUEUED|RUNNING|DONE|FAILED), attempts, run_after, locked_until, last_error, created_at

processed_updates (update_id PRIMARY KEY, received_at)    -- дедуп Telegram, чистится через 7 дней

settings (key PRIMARY KEY, value jsonb)                    -- шаблоны текстов, задержка follow-up, лимиты
```

Почему `funnel_events` и `analytics_events` раздельно: первая — бизнес-история человека, которую видит админ («скачал Canton Fair, потом Paper Cup»). Вторая — технические метрики (ошибки отправки, блокировка бота и т. п.). Если захотите проще, можно оставить одну таблицу — решение не блокирующее.

---

## I. RESEARCH ARCHITECTURE — как будет работать web research

**Сегодня в коде research нет** (раздел C). Предложение:

### I.1 Провайдер поиска

| Вариант | Как работает | Цена | Рекомендация |
|---|---|---|---|
| **Anthropic `web_search` + `web_fetch`** (серверные инструменты Claude) | Claude сам ищет и открывает страницы; ответ содержит citations с `url`, `title`, `cited_text` | $10 за 1000 поисков + токены (VERIFIED). Цена `web_fetch` на странице не указана — UNKNOWN, проверим на Phase 6. | **Основной.** Один ключ, источники возвращаются автоматически. |
| Tavily Search API | Отдельный поиск, мы передаём результаты в Claude | Free 1000 кредитов/мес, далее $0.008/кредит (VERIFIED) | Резерв / второй поисковик, если нужен контроль запросов. |
| Ручные URL от вас | Вы присылаете ссылку на каталог завода / сайт выставки → `web_fetch` | только токены | Обязательная опция: часто лучший источник — тот, что вы уже нашли. |

### I.2 Поток (одна выставка или одна линия)

```
DISCOVER  (админ: «найди 5 выставок / 5 производственных идей»)
  → job DISCOVER_CANDIDATES → 5 кандидатов с 1–2 источниками каждый → карточки админу
CHOOSE    (админ нажимает один)
RESEARCH  → job RESEARCH_STEP ×N: каждый шаг заполняет блок полей (оборудование / рынок / логистика)
           Claude возвращает JSON по Pydantic-схеме: {value, unit, classification, source_urls[], quote}
VERIFY    → код проверяет:  у VERIFIED есть URL, который реально был открыт в этом сеансе
           (url ∈ citations); иначе понижает до UNKNOWN; marketplace-источник ≠ VERIFIED цена завода
CALCULATE → детерминированный движок (раздел J)
PREVIEW   → админ видит таблицу полей с метками и источниками, расчёт, черновик поста
APPROVE   → research_items.status = ACTIVE
```

### I.3 Правила, которые обеспечивает код, а не промпт

- **Источник без URL из citations не принимается.** Модель не может «придумать» ссылку: мы сверяем URL со списком реально открытых.
- **Иерархия источников** (§10) хранится как `source_type`. Цена с маркетплейса получает максимум `MARKET DATA`, никогда `VERIFIED` для цены завода.
- **UNKNOWN не превращается в число.** Поле без значения остаётся UNKNOWN, а расчёты, которые от него зависят, помечаются «не рассчитано» (раздел J).
- **Свежесть:** `research_date`, `retrieved_at`, `source_date` (если есть). Cron раз в сутки переводит в `NEEDS_REVIEW`, когда:
  - выставка уже прошла;
  - ценовым данным больше N дней (настройка, по умолчанию 90).
- **Языки источников:** промпт требует искать на китайском и английском (официальные сайты заводов, выставок). Перевод терминов — с оригиналом в скобках.
- **Стоимость** каждого research пишется в `research_items.ai_cost_usd`. Месячный лимит из Phase 1A сохраняется.

### I.4 Ожидаемая стоимость одного research-пакета — ESTIMATED

- Выставка: 15–30 поисков + 50–150K токенов Sonnet ≈ **$0.5–2**.
- Производственная модель (оборудование + рынок Узбекистана): 40–80 поисков + 150–400K токенов ≈ **$2–6**.
- PDF создаётся один раз, клиентам выдаётся готовый файл, поэтому стоимость не зависит от числа скачиваний.

---

## J. CALCULATION ENGINE — детерминированный расчёт

LLM только собирает **входные данные** с метками. Вся арифметика делается в Python (`Decimal`).

### J.1 Входы (пример для бумажных стаканов)

Каждое поле хранится так:
```json
"units_per_minute": {"value": 80, "unit": "pcs/min", "classification": "VERIFIED",
                     "source_ids": [12], "note": "manufacturer spec, theoretical max"}
```

Группы входов:
- **Оборудование:** `machine_price`, `extra_equipment[]`, `power_kw`, `units_per_minute_max`, `operators_per_shift`, `area_m2`.
- **Логистика и запуск:** `shipping`, `customs_duty_pct`, `vat_pct`, `installation`, `facility_prep`, `other_capex[]`.
- **Режим работы:** `hours_per_shift`, `shifts_per_day`, `working_days_month`, `utilization`, `scrap_rate`.
- **Сырьё:** `raw_material_per_unit` (кг или м² на единицу), `raw_material_price` (за кг/т).
- **Расходы:** `electricity_tariff`, `wage_per_operator_month`, `rent_per_m2_month`, `packaging_per_unit`, `maintenance_pct_capex_year`, `other_fixed_month`.
- **Продажи:** `selling_price_per_unit` (опт, Узбекистан).

### J.2 Формулы (каждая выводится в превью как «вход → формула → результат»)

```
units_per_hour_effective = units_per_minute_max × 60 × utilization
good_units_month         = units_per_hour_effective × hours_per_shift × shifts_per_day
                           × working_days_month × (1 − scrap_rate)
CAPEX_total              = machine_price + Σextra_equipment + shipping + customs/VAT + installation
                           + facility_prep + Σother_capex
raw_cost_per_unit        = raw_material_per_unit × raw_material_price / (1 − scrap_rate)
energy_month             = power_kw × hours_per_shift × shifts_per_day × working_days_month
                           × load_factor × electricity_tariff
variable_cost_per_unit   = raw_cost_per_unit + packaging_per_unit + energy_month / good_units_month
fixed_month              = operators × shifts × wage + area × rent + CAPEX × maintenance_pct / 12
                           + other_fixed_month
revenue_month            = good_units_month × selling_price_per_unit
gross_profit_month       = revenue_month − good_units_month × variable_cost_per_unit
operating_profit_month   = gross_profit_month − fixed_month
contribution_per_unit    = selling_price_per_unit − variable_cost_per_unit
break_even_units_month   = fixed_month / contribution_per_unit         (только если contribution > 0)
break_even_revenue       = break_even_units_month × selling_price_per_unit
payback_months           = CAPEX_total / operating_profit_month         (только если profit > 0;
                           методика: операционная прибыль до налогов как прокси cash flow,
                           без оборотного капитала и кредита — пишется в PDF)
scenarios                = тот же расчёт при utilization = 0.5 / 0.7 / 0.9
```

### J.3 Правила

1. **Нет входа — нет результата.** Если входа нет (UNKNOWN), зависимые выходы получают `NOT_COMPUTABLE` с указанием причины. Никаких подстановок «по памяти».
2. **Метка результата:** `CALCULATED`, плюс самая слабая метка среди входов («CALCULATED из ESTIMATED-входов»). Это видно в превью и в PDF.
3. **Теоретическая производительность** станка не используется напрямую: `utilization` и `scrap_rate` обязательны. Значения по умолчанию (например, 70% и 3%) явно помечены как `ASSUMPTION`.
4. Формулы `capacity × price = profit` нет физически: прибыль считается только через `revenue − variable − fixed`.
5. Валюты: каждый вход хранит свою валюту, курс — отдельный вход с датой и источником (ЦБ Узбекистана). Всё пересчитывается в USD и UZS.
6. Движок — чистая функция, покрыта unit-тестами на эталонных примерах. Это основа доверия к PDF.

---

## K. PDF ARCHITECTURE

| Вопрос | Решение |
|---|---|
| Генерация | **ReportLab** (Python, ставится из pip без системных библиотек). WeasyPrint требует системные pango/cairo — их наличие на Vercel UNKNOWN, поэтому не выбираем. Headless Chromium (HTML→PDF) возможен, но тяжёлый и медленный. |
| Шрифты | Noto Sans / DejaVu (кириллица + узбекская латиница с `oʻ`, `gʻ`), лежат в репозитории. |
| Где генерируется | В job `RENDER_PDF` из cron-функции: память до 2 ГБ, до 300 с (VERIFIED). Генерация разовая, на один lead magnet. |
| Где хранится оригинал | **Vercel Blob, приватный store**, путь `lead-magnets/<slug>/v<version>.pdf`. Постоянного диска нет, `/tmp` только на время вызова. |
| Как выдаётся клиентам | **По `tg_file_id`.** PDF один раз отправляется в чат админа на превью, Telegram возвращает `file_id`, дальше клиентам уходит `sendDocument(file_id)`. Повторная загрузка не нужна (VERIFIED: Bot API разрешает переиспользовать `file_id`). Выдача мгновенная, без трафика Blob и без нагрузки на функцию. |
| Размер | Документ через Bot API — до 50 МБ (VERIFIED по документации Bot API). Целимся в 2–8 МБ (сжатые фото). |
| Версии | `paper-cup v1` → `v2` — новая строка `lead_magnets` и новый файл. Старые не перезаписываются. Funnel ссылается на `slug` и отдаёт последнюю ACTIVE-версию, а в `funnel_events` пишется, какая версия ушла. |
| Шаблон | Общая обложка, колонтитул с датой research и дисклеймером. На каждой странице с цифрами — блок «Prices are indicative and valid as of [DATE]» и метки данных. |
| Ручной PDF | Админ может просто прислать боту готовый PDF (`/upload_pdf slug`). Это важно для Phase 2: воронку можно проверить до AI-генерации. |

## L. IMAGE ARCHITECTURE

| Источник | Правило |
|---|---|
| Сайт производителя / выставки / организатора | Используем, только если права позволяют (press kit, явная лицензия, письменное разрешение завода) или вы подтверждаете право. В `research_items.data.images[]` хранится: `source_url`, `page_url`, `license_status` (ALLOWED/PERMISSION_GRANTED/UNKNOWN), `depicts` (точная модель). |
| Фото, присланные заводом / вами | Лучший вариант. Загружаются через бота → Blob → `license_status=OWN`. |
| AI-иллюстрация | Только как иллюстрация, с подписью «AI-generated illustration», и **никогда** для конкретного станка, завода, выставки или продукта. В MVP генерацию изображений не делаем. |
| UNKNOWN-права | В PDF и пост не попадают. В превью админ видит только ссылку. |
| Хранение | Vercel Blob (приватный для рабочих материалов, публичный для картинок постов). Для поста картинка отправляется в Telegram и тоже переиспользуется по `file_id`. |
| Соответствие | Картинка привязана к `machine_model`. Код запрещает вставлять в раздел «Selected Production Line» изображение с другим `depicts`. |

## M. FOLLOW-UP ARCHITECTURE (2–3 часа, serverless)

1. При `PDF_SENT` в той же транзакции: `INSERT followups (user_id, lead_magnet_id, due_at = now() + settings.followup_delay /* 150 мин */) ON CONFLICT DO NOTHING`. На один PDF — максимум один follow-up.
2. **Vercel Cron `* * * * *`** вызывает `/api/cron/tick` (на Pro — раз в минуту, точность по минуте, VERIFIED).
3. `tick` берёт до 50 записей: `SELECT … WHERE status='PENDING' AND due_at <= now() FOR UPDATE SKIP LOCKED`. Два одновременных tick не отправят одно и то же.
4. Перед отправкой — проверки, иначе `CANCELLED` с причиной:
   - пользователь уже нажал «Хочу обсудить» / INTERESTED / стал QUALIFIED;
   - `opted_out` (нажал NOT NOW) или `is_blocked_bot`;
   - за последние 24 ч ему уже отправляли follow-up (по другому PDF) — антиспам;
   - тихие часы 22:00–09:00 Asia/Tashkent → перенос `due_at` на 09:00 (настройка).
5. Отправка: текст из шаблона + кнопки INTERESTED / QUESTION / NOT NOW. Ответ 403 от Telegram («бот заблокирован») → `is_blocked_bot=true`.
6. **Второго follow-up нет.** Кто не ответил, больше не получает сообщений по этому PDF.

Почему не Queues/Workflows: оба в beta (VERIFIED). Cron + таблица — GA, видно в БД, легко отменить. Если позже понадобится точность до секунды или большие объёмы — `send(..., delay=9000)` в Vercel Queues ложится в ту же модель (`followups` остаётся источником правды).

## N. TELEGRAM CHANNEL PUBLISHING (preview → approval → publish)

1. Бот добавляется админом канала **только с правом «Публикация сообщений»** (плюс «Редактирование», если нужны правки опубликованного). Прочие права не нужны.
2. `content_items` (DRAFT) создаётся AI или вами.
3. Админ получает **точное превью**: тот же текст, медиа и кнопка, отправленные себе в личку. Кнопки: ✅ APPROVE / ✏️ EDIT / ❌ REJECT.
   - EDIT: вы присылаете новый текст → новое превью;
   - APPROVE: статус APPROVED → job `PUBLISH_POST`, либо публикация сразу (она быстрая).
4. Публикация: `sendPhoto`/`sendMessage` в `CHANNEL_ID` с inline URL-кнопкой `https://t.me/<bot>?start=<funnel.code>`. Payload — до 64 символов `A-Za-z0-9_-` (VERIFIED).
5. Сохраняется `channel_message_id`, `published_at` → `admin_actions`.
6. Ничего не публикуется без APPROVE. Автопубликации в MVP нет.
7. Перед APPROVE поста производственной модели код проверяет, что связанный `research_item` = ACTIVE, а `lead_magnet` = APPROVED (§40).

## O. LEAD FUNNEL — точная state machine

```
            /start <code>                PDF отправлен
 (нет) ───────────────▶ VISITOR ─────────────────────▶ LEAD
                                                         │
     2+ разных PDF  или  «Хочу обсудить» после PDF       ▼
                                                      ENGAGED
                                                         │  INTERESTED (кнопка в CTA или follow-up)
                                                         ▼
                                                     INTERESTED ──▶ 2–3 вопроса квалификации
                                                         │                (state в users.state)
                                         все ответы + «нужна помощь»=да
                                                         ▼
                                                     QUALIFIED ──▶ уведомление админу 🔥
                                                         │
                                  админ: MARK CONTACTED  │   админ: NOT QUALIFIED
                                                         ▼                 ▼
                                                     CONTACTED        NOT_QUALIFIED
```

- Переходы **только вперёд** (кроме NOT_QUALIFIED, его ставит только админ). Повторный /start не понижает стадию.
- **QUESTION** → «Напишите вопрос» → текст пересылается админу, стадия ≥ INTERESTED (это сигнал интереса).
- **NOT NOW** → `opted_out_followups` для этого PDF, стадия не меняется, остальные follow-ups отменяются.
- **Квалификация — выставка:** 1) сколько человек едет (1 / 2 / 3–5 / 6+), 2) когда планируете (эта фаза / следующая / пока изучаю), 3) нужна ли помощь с организацией (да / нет).
- **Квалификация — производство:** 1) бюджет (до $50k / 50–150k / 150–500k / 500k+ / пока не знаю), 2) где планируете (город/регион, кнопки + «другое»), 3) сроки (≤3 мес / 3–12 мес / изучаю), 4) нужен ли подбор оборудования (да / нет).
- Все ответы — кнопками, кроме города. Тексты вопросов лежат в `settings`, а не в коде (§32).
- **Score (детерминированный):** PDF +1 за каждый уникальный, INTERESTED +3, QUESTION +2, квалификация завершена +5, запрос контакта +5. Score нужен только для сортировки в админке; стадию задают правила выше.
- **HOT SIGNAL (§43):** ≥ 3 уникальных PDF за 14 дней **или** (≥ 2 PDF и INTERESTED) → одно уведомление админу «Engagement signal (не гарантия покупки)», не чаще раза в 7 дней на человека.
- **Уведомление о QUALIFIED:** имя, @username / ссылка `tg://user?id=…`, кампания, lead magnet (+версия), стадия, ответы, все PDF человека с датами, источник, время. Кнопки: OPEN CHAT (URL-кнопка), MARK CONTACTED, NOT QUALIFIED.

## P. ANALYTICS EVENTS

| Событие | Когда | Где |
|---|---|---|
| `post_published` | публикация в канал | analytics_events |
| `bot_start` (+ `funnel_code`, `is_new_user`) | /start | funnel_events START |
| `pdf_sent` (+ slug, version) | успешный sendDocument | funnel_events |
| `service_cta_shown` / `service_cta_click` | после PDF / «Хочу обсудить» | funnel_events |
| `followup_sent` / `followup_cancelled` (+ причина) | cron | funnel_events / analytics |
| `followup_reply` (INTERESTED/QUESTION/NOT_NOW) | кнопка | funnel_events |
| `qual_answer`, `qualified` | квалификация | funnel_events |
| `hot_signal` | правило §43 | funnel_events |
| `contacted` / `not_qualified` | админ | funnel_events + admin_actions |
| `bot_blocked` | 403 от Telegram | analytics_events |
| `research_cost` | завершение research | analytics_events |

**Чего Telegram не даёт (важно для ожиданий):**
- Клик по URL-кнопке в канале боту не сообщается. Видим только факт `/start <code>`, поэтому «CTA click» = `bot_start` с этим кодом.
- Просмотры поста Bot API не отдаёт: ESTIMATED, это видно в статистике канала вручную. Ввод просмотров вручную — опция, не блокер.

**Отчёт в админке** («Statistics»), по кампании и по lead magnet: starts → unique users → PDF → follow-up sent → replies → interested → qualified → contacted, плюс конверсия между шагами. Это ровно метрики §57.

## Q. SECURITY AUDIT (значения секретов не выводились)

Проверено: git-история бандла (`git log -p --all`, оба коммита) и рабочее дерево Phase 1A, по шаблонам Telegram-токена, ключа Anthropic, URL Postgres с паролем и по именам файлов `.env`, `*.pem`, `*.key`.

| Находка | Где | Тип | Риск |
|---|---|---|---|
| Пароль-заглушка `PASSWORD` в закомментированном `DATABASE_URL` | `.env.example` | плейсхолдер | нет |
| Пароль `ai_office` для тестовой БД | `ci.yml`, `config.py` (default), `tests/conftest.py` | локальная/CI тестовая БД | нет (не production); в новом проекте default уберём |
| Строки вида `sk-ant-…`, `postgresql://user:…` | `tests/test_logging_and_config.py` | фиктивные значения для теста маскирования | нет |
| Реальные токены Telegram / ключи Anthropic / `.env` | — | **не найдены** | — |

**Вывод: утечек нет, ротация не требуется.** Если старый «Assistant Bot» существует в другом месте, его репозиторий нужно проверить отдельно (вопрос V1).

Правила для нового проекта:
- Секреты только в Vercel Environment Variables, отдельно для Production и Preview: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`, `ADMIN_TG_IDS`.
- `gitleaks` в CI (уже есть) и pre-commit.
- Маскирование логов (уже есть).
- Webhook: проверка secret token → 403. Дедуп по `update_id`. Ответ 200 даже при внутренней ошибке обработки (ошибка логируется), чтобы Telegram не повторял апдейт бесконечно.
- `/api/cron/tick` принимает только `Authorization: Bearer $CRON_SECRET`.
- Админ определяется по `tg_user_id` из env. Админские команды через `setMyCommands` со scope `BotCommandScopeChat(admin_id)`: клиенты их не видят. Каждый админский callback перепроверяет права на сервере (не доверяем скрытию кнопок).
- **Commercial safety (§54):** клиентам уходят только PDF со статусом APPROVED и шаблоны из `settings`. Внутренние поля (`internal_notes`, `supplier_contacts`, маржа) лежат в отдельном ключе `data.internal` и не попадают в рендер PDF. Это закрепим тестом.
- Персональные данные: храним минимум (tg id, имя, username, ответы). Телефон не просим. Вопрос локализации данных — V5.

## R. VERCEL SERVICES / EXTERNAL SERVICES

| Сервис | Для чего | Free tier | Ожидаемая стоимость MVP | Почему нужен |
|---|---|---|---|---|
| **Vercel Pro** | Хостинг функций, Cron, env, превью-деплои | Hobby бесплатный, но **некоммерческий** и cron раз в день (VERIFIED) | **$20/мес** = 1 место + $20 кредита на использование (VERIFIED). Функции, Blob, Cron MVP укладываются в кредит — ESTIMATED | Коммерческое использование и cron каждую минуту |
| Vercel Functions | webhook, cron, генерация PDF | входит | в кредите (1M вызовов; CPU с $0.128/ч, VERIFIED). Cron раз в минуту ≈ 43 200 вызовов/мес — ESTIMATED | рантайм |
| Vercel Cron | follow-ups, jobs | входит во все планы, до 100 задач (VERIFIED) | $0 сверх функций | замена worker и crontab |
| Vercel Blob | оригиналы PDF, картинки | Hobby 1 ГБ; Pro $0.023/ГБ-мес (VERIFIED) | < $1/мес — ESTIMATED (десятки PDF по 5 МБ, выдача через Telegram `file_id`) | нет постоянного диска |
| **Neon Postgres** (через Vercel Marketplace) | вся БД | Free: 1 ГБ на проект, 100 CU-часов, засыпает через 5 мин (VERIFIED) | **$0** на старте. Launch по факту использования ($0.106/CU-ч, $0.35/ГБ-мес, VERIFIED), если упрёмся: ESTIMATED $5–15/мес | managed, serverless, есть ветки для staging |
| **Anthropic API** | research, черновики постов | нет | Sonnet 5.5 $2/$10 за 1M (VERIFIED). Web search $10/1000 (VERIFIED). **ESTIMATED $20–60/мес** при 8–15 research-пакетах и черновиках в месяц. Жёсткий лимит `AI_MONTHLY_BUDGET_USD` | AI-система |
| Tavily (опционально) | второй поисковик | 1000 кредитов/мес бесплатно (VERIFIED) | $0 | резерв, если не хватит web_search |
| Telegram Bot API | бот, канал | бесплатно | $0 | интерфейс |
| GitHub | код, CI | бесплатно для приватных репо (лимиты Actions) — ESTIMATED | $0 | source of truth |
| Домен | не обязателен | — | $0 (webhook работает на `*.vercel.app`; Pro даёт бесплатный домен на 1 год, VERIFIED) | — |

**Итого MVP: ≈ $20 фиксировано + $20–60 AI ≈ $40–80/мес (ESTIMATED).** Для сравнения, план AI Office с VPS был сопоставим по деньгам, но требовал администрирования сервера.

## S. MIGRATION PLAN — как безопасно перейти

Так как работающего бота в проекте нет, «миграция» сводится к созданию нового сервиса рядом. Если старый бот найдётся (V1), правила такие же:

1. **Новый бот для разработки** (`…_staging_bot` из BotFather). Production-бот (старый или новый) не трогаем.
2. Новый репозиторий `china-funnel-bot`. Переносим выборочно (раздел B): provider, config, logging, проверку webhook, тесты.
3. Vercel-проект, привязанный к репо. Preview-деплои на ветки и Production на `main`. Neon: ветка `main` для prod и ветка `dev` для preview.
4. Схема — новая миграция Alembic `0001` в новом репозитории; применяется вручную/CI к Neon (не при старте функции).
5. `setWebhook` только для staging-бота на preview-URL. Тест: /start с payload → PDF → follow-up (задержка 2 мин в staging) → квалификация → уведомление.
6. Когда staging прошёл: production-бот → `setWebhook` на production-URL.
   - Если старый бот работал через **polling** — сначала остановить его процесс, затем `setWebhook`. Telegram не отдаёт апдейты через getUpdates, пока стоит webhook.
   - Откат = `deleteWebhook` + запуск старого процесса.
7. Канал: добавить бота админом с правом публикации только после того, как превью/APPROVE проверены в тестовом канале.

## T. ЧТО БУДЕТ СО СТАРЫМ КОДОМ AI OFFICE

Рекомендация: **отдельный репозиторий, заморожен**.
- Запушить бандл в приватный репо `ai-office` как есть (`main` + тег `phase-1a-frozen`). В README первая строка: «FROZEN 2026-10-03, see china-funnel-bot».
- Файлы в `/mnt/project-files/ai-office/` остаются без изменений (я их не трогал).
- **Не делать** funnel-бот веткой внутри `ai-office`: разные рантаймы (Docker/VPS против Vercel) и разные схемы БД. Ветка быстро разойдётся и будет мешать.
- Будущее расширение: Odoo, агенты и Web Office позже подключаются к БД funnel-бота (`users`, `leads`, `funnel_events`) как к источнику лидов. Схема выше не закрывает этот путь: `users.id` и `leads` станут входом для CRM-синхронизации. Agent-архитектуру из v2 тогда можно поднять из замороженного репо.

## U. MVP DEVELOPMENT PHASES (маленькие шаги)

Каждая фаза заканчивается тем, что вы можете что-то проверить в Telegram.

| Фаза | Что делаем | Результат для вас |
|---|---|---|
| **0. Подготовка** | Вы: репо, Vercel Pro, Neon через Marketplace, staging-бот, тестовый канал. Я: скелет репо, CI, env-шаблон | Пустой сервис отвечает на `/api/health` |
| **1. Webhook-скелет** | FastAPI на Vercel, webhook + secret + дедуп, `users`, админ по `ADMIN_TG_IDS`, `/start` с payload пишет `bot_start` | Бот отвечает, админ видит админ-меню, клиент — нет |
| **2. PDF Library + выдача** ⭐ | `lead_magnets`, `funnels`, загрузка готового PDF админом → `file_id`, deep link → PDF + service CTA, `funnel_events` | **Можно запускать первую реальную кампанию с PDF, сделанным вручную** |
| **3. Follow-up + квалификация + handoff** | `followups` + Cron, кнопки, вопросы, QUALIFIED → уведомление, HOT SIGNAL, MARK CONTACTED | Полная воронка до лида |
| **4. Публикация в канал** | `content_items`, превью → APPROVE/EDIT/REJECT → пост с кнопкой | Посты через бота |
| **5. Статистика** | Отчёт по кампаниям в админке | Метрики §57 |
| **6. Research: выставки** | `sources`, `research_items`, web_search, VERIFY-правила, свежесть, превью полей с источниками | AI готовит research-пакет выставки на ревью |
| **7. Расчёт + производственный research** | Движок J с тестами, research оборудования и рынка УЗ, превью «вход → формула → результат» | Проверяемая бизнес-модель |
| **8. Генерация PDF** | ReportLab-шаблоны (выставка, производство), Blob, версии | PDF генерируется из одобренного research |
| **9. AI-черновики постов + discover** | «Найди 5 выставок / идей», черновик поста из research | Контент-цикл из админки |

Фазы 1–3 не зависят от AI-research: их можно запустить и мерить конверсию, пока строятся 6–9.

## V. QUESTIONS FOR ME — только блокеры

1. **Где существующий Telegram Assistant Bot?** В подключённом GitHub нет ни одного репозитория, в проекте есть только неразвёрнутый код AI Office. Варианты:
   - (а) его нет, вы имели в виду AI Office → **строим новый** (рекомендую);
   - (б) он есть → подключите репо к GitHub (https://claude.ai/connect-github) или назовите @username бота и где он работает.
2. **Vercel Pro за $20/мес — согласны?** Hobby запрещает коммерческое использование и не даёт cron чаще раза в день.
3. **Новый приватный репозиторий** (предлагаю `china-funnel-bot`): создайте его в GitHub и подключите к Claude. Без этого код некуда пушить. Заодно: пушим ли AI Office в отдельный `ai-office` (раздел T)?
4. **Бот и канал:** новый бот под воронку или существующий? Есть ли уже канал (нужен его @username или id) и тестовый канал? Ваш Telegram ID для админ-доступа (через @userinfobot) понадобится на Phase 1 — **вводится в Vercel env, не в чат**.
5. **Персональные данные граждан Узбекистана.** Закон Узбекистана о персональных данных (поправки 2021 г.) требует хранить такие данные на серверах в Узбекистане. Применимость к Telegram-боту, который хранит tg id и ответы, — UNKNOWN, это вопрос к юристу. Vercel и Neon не имеют регионов в Узбекистане. Решение: (а) запускаем MVP с EU-хостингом и минимумом данных, параллельно консультируемся (рекомендую); (б) сначала юрист.

Не блокеры (возьму значения по умолчанию, если не скажете иначе):
- Python, а не TypeScript;
- регион `fra1`;
- follow-up через 150 мин;
- тихие часы 22:00–09:00;
- узбекский латиницей основной, русский вторым.

---

## MVP ARCHITECTURE STATUS: **NEEDS DECISIONS**

Архитектура готова технически (Vercel Functions + Cron + Blob, Neon, Anthropic web search, детерминированный расчёт). Для старта Phase 0 нужны ответы на V1–V5. До вашего APPROVE ничего не делаю.

---

## Источники (проверены 2026-10-03)

- Vercel Functions limits (duration 300 s Hobby / 800 s Pro, memory, 4.5 MB body, Python 500 MB): https://vercel.com/docs/functions/limitations
- Vercel Cron (100 задач, Hobby раз в день ±59 мин, Pro раз в минуту): https://vercel.com/docs/cron-jobs/usage-and-pricing
- Vercel Hobby — только некоммерческое использование: https://vercel.com/docs/limits/fair-use-guidelines
- Vercel Pro ($20 + $20 кредита): https://vercel.com/docs/plans/pro-plan ; https://vercel.com/pricing
- Vercel Queues (beta, delay ≤ 7 дней, TTL ≤ 7 дней): https://vercel.com/docs/queues ; https://vercel.com/docs/queues/pricing ; Python SDK: https://vercel.com/docs/queues/python-sdk
- Vercel Workflows (Python SDK beta, `sleep`): https://vercel.com/docs/workflows ; https://workflow-sdk.dev/docs/getting-started/python
- Vercel Blob pricing: https://vercel.com/docs/vercel-blob/usage-and-pricing
- Vercel Python runtime (FastAPI, 3.12–3.14): https://vercel.com/docs/functions/runtimes/python
- Neon pricing: https://neon.com/pricing
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing ; web search tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- Tavily pricing: https://www.tavily.com/pricing
- Telegram deep linking (64 символа): https://core.telegram.org/bots/features#deep-linking ; setWebhook / secret token / file_id: https://core.telegram.org/bots/api#setwebhook
