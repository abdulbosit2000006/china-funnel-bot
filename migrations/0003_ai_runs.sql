-- AI research runs (OpenAI Responses API in background mode, polled by the cron).
CREATE TABLE ai_runs (
  id               INTEGER PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('DISCOVER','RESEARCH')),
  status           TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED')),
  request          TEXT NOT NULL,             -- JSON: {topic} or {candidate}
  chat_id          INTEGER NOT NULL,
  model            TEXT,
  response_id      TEXT,
  rounds           INTEGER NOT NULL DEFAULT 0, -- 1 = first answer, 2+ = repair rounds
  result           TEXT,                       -- JSON on success
  error            TEXT,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  web_searches     INTEGER NOT NULL DEFAULT 0,
  research_item_id INTEGER REFERENCES research_items(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX ai_runs_status ON ai_runs(status, id);
