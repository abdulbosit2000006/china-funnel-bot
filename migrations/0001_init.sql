-- China Funnel Bot: initial schema (Cloudflare D1 / SQLite).
-- Timestamps are ISO-8601 UTC strings. JSON columns hold TEXT validated by the application.

-- People who wrote to the bot. One row per Telegram user, never duplicated.
CREATE TABLE users (
  id               INTEGER PRIMARY KEY,
  tg_user_id       INTEGER NOT NULL UNIQUE,
  username         TEXT,
  first_name       TEXT,
  language         TEXT NOT NULL DEFAULT 'uz',          -- uz | ru
  first_source     TEXT,                                 -- deep-link code of the first /start
  first_funnel_id  INTEGER REFERENCES funnels(id),
  is_blocked_bot   INTEGER NOT NULL DEFAULT 0,
  opted_out        INTEGER NOT NULL DEFAULT 0,
  state            TEXT,                                 -- current qualification step
  state_data       TEXT,                                 -- JSON
  created_at       TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL
);

-- Every source a research step actually opened.
CREATE TABLE sources (
  id            INTEGER PRIMARY KEY,
  url           TEXT NOT NULL,
  title         TEXT,
  publisher     TEXT,
  source_type   TEXT NOT NULL CHECK (source_type IN
                  ('PRIMARY','OFFICIAL','MANUFACTURER','GOV_INDUSTRY','SECONDARY','MARKETPLACE')),
  language      TEXT,
  source_date   TEXT,
  retrieved_at  TEXT NOT NULL,
  content_hash  TEXT,
  snippet       TEXT
);
CREATE INDEX sources_url ON sources(url);

-- One research package (exhibition, production line, market).
CREATE TABLE research_items (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('EXHIBITION','MANUFACTURING','MARKET','MACHINERY','RAW_MATERIAL')),
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                  ('DRAFT','IN_REVIEW','ACTIVE','NEEDS_REVIEW','OUTDATED','REJECTED')),
  research_date TEXT NOT NULL,
  valid_until   TEXT,
  data          TEXT NOT NULL DEFAULT '{}',  -- JSON: {field: {value, unit, classification, source_ids, note}}
  calc          TEXT,                         -- JSON: calculation engine output (input -> formula -> result)
  ai_cost_usd   REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  approved_at   TEXT,
  approved_by   INTEGER
);

CREATE TABLE research_item_sources (
  research_item_id INTEGER NOT NULL REFERENCES research_items(id),
  source_id        INTEGER NOT NULL REFERENCES sources(id),
  field_path       TEXT NOT NULL,
  PRIMARY KEY (research_item_id, source_id, field_path)
);

-- PDF lead magnets. A new version is a new row; history is never overwritten.
CREATE TABLE lead_magnets (
  id                INTEGER PRIMARY KEY,
  slug              TEXT NOT NULL,
  version           INTEGER NOT NULL,
  type              TEXT NOT NULL CHECK (type IN
                      ('EXHIBITION_GUIDE','MANUFACTURING_MODEL','MACHINERY_GUIDE','RAW_MATERIAL_GUIDE')),
  title             TEXT NOT NULL,
  language          TEXT NOT NULL DEFAULT 'uz',
  research_item_id  INTEGER REFERENCES research_items(id),
  research_date     TEXT,
  status            TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                      ('DRAFT','APPROVED','ACTIVE','OUTDATED','ARCHIVED')),
  r2_key            TEXT,                -- original file in R2
  tg_file_id        TEXT,                -- reused for instant delivery
  file_sha256       TEXT,
  intro_template    TEXT,
  cta_template      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (slug, version)
);

-- Channel posts.
CREATE TABLE content_items (
  id                 INTEGER PRIMARY KEY,
  lead_magnet_id     INTEGER REFERENCES lead_magnets(id),
  funnel_id          INTEGER REFERENCES funnels(id),
  text               TEXT NOT NULL,
  media              TEXT,                 -- JSON
  status             TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                       ('DRAFT','PREVIEW','APPROVED','PUBLISHED','REJECTED')),
  channel_message_id INTEGER,
  published_at       TEXT,
  created_at         TEXT NOT NULL
);

-- Campaigns: the code is the deep-link payload (t.me/<bot>?start=<code>).
CREATE TABLE funnels (
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 64),
  kind              TEXT NOT NULL CHECK (kind IN
                      ('EXHIBITION','MANUFACTURING','MACHINERY','RAW_MATERIAL','GENERAL')),
  lead_magnet_slug  TEXT,
  content_item_id   INTEGER REFERENCES content_items(id),
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);

-- One lead row per person (not per PDF).
CREATE TABLE leads (
  id                 INTEGER PRIMARY KEY,
  user_id            INTEGER NOT NULL UNIQUE REFERENCES users(id),
  stage              TEXT NOT NULL DEFAULT 'VISITOR' CHECK (stage IN
                       ('VISITOR','LEAD','ENGAGED','INTERESTED','QUALIFIED','CONTACTED','NOT_QUALIFIED')),
  score              INTEGER NOT NULL DEFAULT 0,
  hot_signal_at      TEXT,
  last_funnel_id     INTEGER REFERENCES funnels(id),
  answers            TEXT,                -- JSON
  notified_admin_at  TEXT,
  contacted_at       TEXT,
  updated_at         TEXT NOT NULL
);

-- Business history of a person in the funnel.
CREATE TABLE funnel_events (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  funnel_id       INTEGER REFERENCES funnels(id),
  lead_magnet_id  INTEGER REFERENCES lead_magnets(id),
  type            TEXT NOT NULL CHECK (type IN
                    ('START','PDF_SENT','CTA_CLICK','FOLLOWUP_SENT','FOLLOWUP_REPLY','INTERESTED',
                     'QUESTION','NOT_NOW','QUAL_ANSWER','QUALIFIED','HOT_SIGNAL','CONTACTED',
                     'NOT_QUALIFIED','OPT_OUT')),
  payload         TEXT,                   -- JSON
  created_at      TEXT NOT NULL
);
CREATE INDEX funnel_events_user ON funnel_events(user_id, created_at);
CREATE INDEX funnel_events_type ON funnel_events(type, created_at);

-- At most one follow-up per person per lead magnet.
CREATE TABLE followups (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  lead_magnet_id  INTEGER NOT NULL REFERENCES lead_magnets(id),
  funnel_id       INTEGER REFERENCES funnels(id),
  due_at          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN
                    ('PENDING','SENDING','SENT','CANCELLED','FAILED')),
  sent_at         TEXT,
  cancel_reason   TEXT,
  UNIQUE (user_id, lead_magnet_id)
);
CREATE INDEX followups_due ON followups(status, due_at);

CREATE TABLE admin_actions (
  id           INTEGER PRIMARY KEY,
  admin_tg_id  INTEGER NOT NULL,
  action       TEXT NOT NULL,
  object_type  TEXT,
  object_id    TEXT,
  details      TEXT,                      -- JSON
  created_at   TEXT NOT NULL
);

-- Technical metrics and diagnostics.
CREATE TABLE analytics_events (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id),
  funnel_id   INTEGER REFERENCES funnels(id),
  props       TEXT,                       -- JSON
  created_at  TEXT NOT NULL
);
CREATE INDEX analytics_events_name ON analytics_events(name, created_at);

-- Background work queue (research steps, PDF rendering, publishing).
CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  run_after     TEXT NOT NULL,
  locked_until  TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX jobs_due ON jobs(status, run_after);

-- Telegram may redeliver an update; each update_id is processed once.
CREATE TABLE processed_updates (
  update_id    INTEGER PRIMARY KEY,
  received_at  TEXT NOT NULL
);

-- Message templates, follow-up delay, limits.
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL                    -- JSON
);
