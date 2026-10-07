# Safe pause / resume

One master switch in `wrangler.jsonc` → `vars`:

```jsonc
"SYSTEM_STATUS": "PAUSED"   // or "ACTIVE"
```

Only an explicit `ACTIVE` turns AI on. Anything else, including a missing value or a typo, counts as **PAUSED**. A broken setting cannot start paid jobs.

## CURRENT STATUS

`SYSTEM_STATUS = PAUSED` since 2026-10-07.

## WHAT WAS PAUSED

These steps of the every-minute cron (`src/app.ts`, `scheduled`) are off:

| Process | What it did | Uses OpenAI |
|---|---|---|
| AI runner (`runAiTick`) | started and polled every AI run (research, plan, machines, posts, cases) | **yes** |
| Weekly content plan (`runContentPlanner`) | Saturday plan, night drafts for Wed/Fri/Sun, 09:00 delivery, views request | **yes** |
| Autopilot (`runAutopilot`) | handed ready research PDFs and posts to the founder at 09:00 | no (it delivers what the AI made) |
| Daily report 09:00 | statistics to the admin | no |
| Monthly report (1st of the month) | statistics to the admin | no |

## HOW OPENAI CALLS WERE STOPPED

- While paused, the Worker never creates an OpenAI client (`aiFor()` in `src/app.ts` returns `null`). With no client, nothing in the bot can call `api.openai.com`.
  - This covers the cron and the webhook: `/find`, `/ideas`, `/research`, `/business`, `/plan`, `/breaking`, `/case` drafts, the "Regenerate" button and voice transcription.
- Those commands answer "⏸ AI is unavailable: the system is paused" and queue nothing.
- Runs that were already queued stay in the `ai_runs` table untouched. They do not start while paused.
- The OpenAI key (`OPENAI_API_KEY` secret), the model settings, the prompts and the code are unchanged.

## WHAT STILL REMAINS ONLINE

These keep working and do not use OpenAI:

- **Telegram webhook.** Clients who press a post's button still get the PDF. The admin panel, statistics, leads, `/expo`, `/week`, `/budget` and publishing ready posts all keep working.
- **Follow-ups to clients.** One message 2.5 hours after a PDF; plain text, no AI.
- **Job queue.** PDF rendering through Cloudflare Browser, used only after a manual research upload.
- **Hourly cleanup** of old Telegram update ids.
- The cron trigger itself (`* * * * *` in `wrangler.jsonc`) still fires. It is kept so the system can be resumed with one change. While paused it does only the online items above. It costs nothing on the Workers Free plan.

Nothing was deleted: the Telegram bot and token, D1 database (users, leads, PDFs, content, research), R2 files, GitHub repository, Cloudflare Worker and all secrets.

The project runs on **Cloudflare Workers**, not Vercel: there is no Vercel project or Vercel cron. The only GitHub Actions are CI on push and the manual "Register Telegram webhook" workflow; neither calls OpenAI.

## HOW TO RESUME

1. On GitHub, open `wrangler.jsonc` on `main` and click ✏️. Change `"SYSTEM_STATUS": "PAUSED"` to `"SYSTEM_STATUS": "ACTIVE"`, then **Commit changes** to `main`.
2. GitHub Actions deploys it automatically, in about 2 minutes. The "CI" run must be green.

Or write **RESUME SYSTEM** in the project chat, and Claude does both steps.

## WHAT TO CHECK AFTER RESUME

- `/autopilot` in the bot shows "Автопилот включён" without the pause warning.
- AI runs queued before the pause start one at a time on the next minutes. They spend OpenAI and may be stale.
- `/budget`: the month's spend and the cap ($10 by default).
- `/week`: if a plan is missing or failed, `/plan` makes a new one; otherwise the next one arrives on Saturday at 12:00.
- The daily report at 09:00 and the monthly report on the 1st come back on their own.
