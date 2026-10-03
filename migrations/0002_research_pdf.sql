-- Generated PDF of a research package, before it becomes a lead magnet.
ALTER TABLE research_items ADD COLUMN slug TEXT;
ALTER TABLE research_items ADD COLUMN pdf_r2_key TEXT;
ALTER TABLE research_items ADD COLUMN pdf_tg_file_id TEXT;
ALTER TABLE research_items ADD COLUMN lead_magnet_id INTEGER REFERENCES lead_magnets(id);
