-- Content System V1: weekly plan (Mon business model, Wed trust, Fri opportunity, Sun insight), text posts,
-- cases, the exhibition list, views and the AI budget.

-- ai_runs gets new kinds; SQLite cannot change a CHECK, so the (small) table is rebuilt.
CREATE TABLE ai_runs_new (
  id               INTEGER PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('DISCOVER','RESEARCH','PLAN','EQUIPMENT','DRAFT','CASE','TRANSCRIBE')),
  status           TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED')),
  request          TEXT NOT NULL,
  chat_id          INTEGER NOT NULL,
  model            TEXT,
  response_id      TEXT,
  rounds           INTEGER NOT NULL DEFAULT 0,
  result           TEXT,
  error            TEXT,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  web_searches     INTEGER NOT NULL DEFAULT 0,
  research_item_id INTEGER REFERENCES research_items(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  subject          TEXT NOT NULL DEFAULT 'EXHIBITION',
  auto_date        TEXT,
  slot_id          INTEGER,                    -- plan_slots.id this run works for
  extra_cost_usd   REAL NOT NULL DEFAULT 0     -- cost not measured in tokens (voice transcription)
);
INSERT INTO ai_runs_new (id, kind, status, request, chat_id, model, response_id, rounds, result, error, input_tokens,
                         output_tokens, web_searches, research_item_id, created_at, updated_at, subject, auto_date)
  SELECT id, kind, status, request, chat_id, model, response_id, rounds, result, error, input_tokens,
         output_tokens, web_searches, research_item_id, created_at, updated_at, subject, auto_date FROM ai_runs;
DROP TABLE ai_runs;
ALTER TABLE ai_runs_new RENAME TO ai_runs;
CREATE INDEX ai_runs_status ON ai_runs(status, id);
CREATE INDEX ai_runs_created ON ai_runs(created_at);

-- One plan per week (week_start = Monday, local date).
CREATE TABLE content_plans (
  id           INTEGER PRIMARY KEY,
  week_start   TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'PLANNING' CHECK (status IN ('PLANNING','DRAFT','APPROVED','FAILED')),
  mode         TEXT NOT NULL DEFAULT 'NORMAL',
  chat_id      INTEGER NOT NULL,
  message_id   INTEGER,                     -- the plan message, edited in place
  notes        TEXT,                        -- JSON: season suggestion, similar exhibitions
  created_at   TEXT NOT NULL,
  approved_at  TEXT
);

CREATE TABLE plan_slots (
  id               INTEGER PRIMARY KEY,
  plan_id          INTEGER REFERENCES content_plans(id), -- NULL for BREAKING
  slot_date        TEXT NOT NULL,          -- local date the post is delivered for review
  rubric           TEXT NOT NULL CHECK (rubric IN ('BUSINESS_MODEL','TRUST','OPPORTUNITY','INSIGHT','BREAKING')),
  status           TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN
                     ('PLANNED','EQUIPMENT','WAITING_EQUIPMENT','RESEARCHING','READY','DELIVERED','PUBLISHED','SKIPPED','REJECTED','FAILED')),
  candidates       TEXT NOT NULL DEFAULT '[]', -- JSON array of scored topics
  chosen           INTEGER,                -- index in candidates
  equipment        TEXT,                   -- JSON: confirmed machine for BUSINESS_MODEL
  equipment_options TEXT,                  -- JSON: options shown to the admin
  content_item_id  INTEGER REFERENCES content_items(id),
  research_item_id INTEGER REFERENCES research_items(id),
  note             TEXT,                   -- why skipped / failed, shown to the admin
  reminded_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX plan_slots_date ON plan_slots(slot_date, status);

-- What every post is, for attribution, dedupe and the monthly report.
ALTER TABLE content_items ADD COLUMN rubric TEXT;
ALTER TABLE content_items ADD COLUMN format TEXT;
ALTER TABLE content_items ADD COLUMN goal TEXT;
ALTER TABLE content_items ADD COLUMN cta_type TEXT;
ALTER TABLE content_items ADD COLUMN topic TEXT;
ALTER TABLE content_items ADD COLUMN topic_key TEXT;
ALTER TABLE content_items ADD COLUMN series_no INTEGER;
ALTER TABLE content_items ADD COLUMN slot_id INTEGER;
ALTER TABLE content_items ADD COLUMN claims TEXT;       -- JSON: [{text, label, source_url, source_date, basis, currency, unit}]
ALTER TABLE content_items ADD COLUMN poll TEXT;         -- JSON: {question, options}
ALTER TABLE content_items ADD COLUMN review_note TEXT;  -- warnings shown with the preview
ALTER TABLE content_items ADD COLUMN reject_reason TEXT;
ALTER TABLE content_items ADD COLUMN views INTEGER;     -- entered by the admin (the Bot API gives no views)
CREATE INDEX content_items_topic ON content_items(topic_key, published_at);

ALTER TABLE research_items ADD COLUMN slot_id INTEGER;

-- Real cases from the founder's notes; only SAFE_TO_USE ones can become posts.
CREATE TABLE content_cases (
  id               INTEGER PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'COLLECTING' CHECK (status IN
                     ('COLLECTING','DRAFTING','DRAFT','NEEDS_REVIEW','SAFE_TO_USE','PUBLISHED','DELETED')),
  notes            TEXT NOT NULL DEFAULT '[]', -- JSON: [{type: text|voice|photo, text?, file_id?}]
  draft            TEXT,                      -- post text (Uzbek)
  redactions       TEXT,                      -- JSON: what was removed
  warnings         TEXT,                      -- JSON: what the code still found (phones, names, sums)
  photo_file_id    TEXT,
  content_item_id  INTEGER REFERENCES content_items(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Exhibitions the founder can organize. The bot proposes similar ones; the founder confirms.
CREATE TABLE exhibition_calendar (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  city          TEXT,
  starts_on     TEXT,                     -- next known start date (YYYY-MM-DD)
  ends_on       TEXT,
  official_site TEXT,
  source_url    TEXT,
  status        TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CANDIDATE','CONFIRMED','REMOVED')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
