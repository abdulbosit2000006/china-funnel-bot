# Запуск бота на Cloudflare — пошагово

Всё бесплатно. Секреты (токены, ключи) вводятся **только** в Cloudflare и GitHub, никогда не пишутся в чат и не попадают в код.

Что получится в конце: бот принимает сообщения через webhook на Cloudflare, вы видите админ-панель, клиенты — только клиентские сообщения.

---

## Шаг 1. Аккаунт Cloudflare

1. Откройте https://dash.cloudflare.com/sign-up и зарегистрируйтесь (почта + пароль), подтвердите почту.
2. В меню слева откройте **Workers & Pages** (или **Compute → Workers**). При первом входе Cloudflare попросит выбрать поддомен `workers.dev`, например `abdul`. Тогда адрес бота будет `https://china-funnel-bot.abdul.workers.dev`. Запомните его.

## Шаг 2. Account ID

На странице **Workers & Pages** справа есть блок **Account details** → **Account ID**. Скопируйте. Это не секрет, но и в чат его присылать не нужно: он пойдёт в GitHub на шаге 5.

## Шаг 3. База данных D1

1. Меню слева: **Storage & Databases → D1 SQL Database** → **Create database**.
2. Name: `china-funnel-bot-db`, регион оставьте по умолчанию (Automatic) → **Create**.
3. На странице базы скопируйте **Database ID** (вида `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
4. **Пришлите этот ID мне в чат.** Это не секрет: я впишу его в `wrangler.jsonc`.

Таблицы создавать не нужно: они создаются автоматически при деплое.

## Шаг 3b. Хранилище файлов R2 (для PDF)

1. Меню слева: **Storage & Databases → R2 Object Storage**. При первом входе Cloudflare может попросить привязать карту, чтобы включить R2. До 10 ГБ хранения бесплатно, скачивание бесплатно.
2. **Create bucket** → Name: `china-funnel-files` → Location: Automatic → **Create bucket**.

Больше ничего делать не нужно: бот сам кладёт туда PDF.

## Шаг 4. API-токен для автодеплоя

1. Справа вверху иконка профиля → **My Profile** → **API Tokens** → **Create Token**.
2. Шаблон **Edit Cloudflare Workers** → **Use template**.
3. В блоке **Permissions** нажмите **+ Add more** и добавьте: `Account` → `D1` → `Edit`.
4. **Account Resources**: выберите свой аккаунт. **Zone Resources**: `All zones` (как в шаблоне).
5. **Continue to summary** → **Create Token** → скопируйте токен. Он показывается один раз. **Это секрет**: никуда, кроме шага 5, его не вставляйте.

## Шаг 5. Секреты в GitHub

Откройте https://github.com/abdulbosit2000006/china-funnel-bot → **Settings** → **Secrets and variables** → **Actions**.

На вкладке **Secrets** нажмите **New repository secret** три раза:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | токен из шага 4 |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID из шага 2 |
| `ADMIN_API_TOKEN` | длинная случайная строка, см. ниже |

Как получить случайную строку: откройте https://1password.com/password-generator, выберите **Random Password**, длина 40, **без символов** (только буквы и цифры) → скопируйте. Сохраните её себе в заметки: она понадобится ещё раз на шаге 7. Сделайте так **две разные строки**: одна для `ADMIN_API_TOKEN`, вторая — для `TELEGRAM_WEBHOOK_SECRET` (шаг 7).

## Шаг 6. Включить автодеплой

Сделайте это после того, как я напишу, что вписал Database ID.

Там же, в **Secrets and variables → Actions**, вкладка **Variables** → **New repository variable**:
- Name: `DEPLOY_ENABLED`
- Value: `true`

Дальше каждое изменение в ветке `main` само проверяется тестами и выкатывается на Cloudflare. Первый деплой я запущу сам. Посмотреть его можно во вкладке **Actions** репозитория (зелёная галочка = успешно).

## Шаг 7. Секреты бота в Cloudflare

Делается после первого успешного деплоя, когда в **Workers & Pages** появится `china-funnel-bot`.

1. Откройте **Workers & Pages → china-funnel-bot → Settings → Variables and Secrets** → **+ Add**.
2. Добавьте четыре значения, каждое с типом **Secret**:

| Variable name | Value | Где взять |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | токен бота | @BotFather → `/mybots` → ваш бот → **API Token** |
| `TELEGRAM_WEBHOOK_SECRET` | вторая случайная строка из шага 5 | — |
| `ADMIN_API_TOKEN` | **та же** строка, что в GitHub на шаге 5 | — |
| `ADMIN_TG_IDS` | ваш Telegram ID (только цифры) | напишите @userinfobot, он ответит вашим Id |

3. **Deploy** (или **Save and deploy**).

## Шаг 8. Подключить Telegram к боту (webhook)

1. GitHub → репозиторий → **Actions** → слева **Register Telegram webhook** → **Run workflow**.
2. В поле `worker_url` вставьте адрес из шага 1, например `https://china-funnel-bot.abdul.workers.dev` → **Run workflow**.
3. Зелёная галочка = готово.

## Шаг 9. Проверка

- Откройте в браузере `https://china-funnel-bot.<поддомен>.workers.dev/health` — должно быть `{"status":"ok"}`.
- Напишите боту `/start` с **вашего** аккаунта → придёт админ-панель с кнопками. Нажмите **📊 Dashboard**.
- Попросите кого-то другого написать боту `/start` → он получит приветствие на узбекском, без админ-кнопок.
- В меню команд бота у вас будут `/start` и `/admin`, у клиентов — только `/start`.

Если что-то не так: **Workers & Pages → china-funnel-bot → Logs** покажет ошибки (токены в логах скрыты). Напишите мне, что видите.
