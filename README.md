# China Business Research & Funnel Bot

Telegram-воронка для предпринимателей из Узбекистана: полезный B2B-контент про Китай в канале →
бот → бесплатный PDF (выставка / производственная бизнес-модель) → follow-up → квалифицированный
лид → основатель.

Работает на **Cloudflare Workers** (webhook, без VPS и polling), база **D1**, файлы **R2**.

- Архитектура: [docs/architecture-cloudflare-v2.md](docs/architecture-cloudflare-v2.md) (исходный аудит: [docs/audit-v1.md](docs/audit-v1.md))
- Запуск на Cloudflare по шагам: [docs/setup-cloudflare.md](docs/setup-cloudflare.md)

## Статус: Phase 1 (webhook-скелет)

| Что | Готово |
|---|---|
| Webhook `/tg/webhook` с проверкой secret token, дедуп `update_id`, ответ 200 даже при ошибке | ✅ |
| Пользователи без дублей, лид VISITOR, `/start <код кампании>` → событие START с кампанией | ✅ |
| Админ-режим в том же боте (по `ADMIN_TG_IDS`), Dashboard; клиенты админку не видят, кнопки перепроверяются на сервере | ✅ |
| `/admin/setup`: webhook + команды для клиентов и админа | ✅ |
| Cron раз в минуту (пока: очистка дедупа) | ✅ |
| Полная схема БД MVP (`migrations/0001_init.sql`) | ✅ |
| PDF-библиотека и выдача по кампании | Phase 2 |
| Follow-up, квалификация, уведомление о лиде | Phase 3 |
| Превью → APPROVE → публикация в канал | Phase 4 |
| Статистика воронки | Phase 5 |
| Автопоиск выставок, research с источниками, расчёт бюджета, PDF, пост | Phase 6–8 |

## Разработка

```bash
npm ci
npm run typecheck
npm test            # тесты в локальном рантайме Workers (Miniflare) с настоящей D1
cp .dev.vars.example .dev.vars && npm run dev   # локальный запуск
```

Деплой: push в `main` → GitHub Actions → тесты → `wrangler d1 migrations apply` → `wrangler deploy`
(включается переменной репозитория `DEPLOY_ENABLED=true`).

## Правила

- Секреты только в Cloudflare/GitHub Secrets. CI запускает gitleaks.
- Клиентам уходят только одобренные материалы. Ничего не публикуется в канал без APPROVE.
- Никаких выдуманных цен, дат, характеристик: каждый важный факт имеет источник или метку
  ASSUMPTION / ESTIMATED / UNKNOWN; арифметику считает код, не LLM.
