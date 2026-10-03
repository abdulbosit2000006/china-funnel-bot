-- Business ideas next to exhibitions, and the morning autopilot.
ALTER TABLE ai_runs ADD COLUMN subject TEXT NOT NULL DEFAULT 'EXHIBITION'; -- EXHIBITION | MANUFACTURING
ALTER TABLE ai_runs ADD COLUMN auto_date TEXT;                          -- autopilot slot (local YYYY-MM-DD)
ALTER TABLE research_items ADD COLUMN auto_date TEXT;                   -- deliver to the admin on this morning
ALTER TABLE research_items ADD COLUMN auto_delivered_at TEXT;
CREATE INDEX research_items_auto ON research_items(auto_date, auto_delivered_at);
