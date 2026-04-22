-- ============================================================================
-- HOOKKA ERP — bom_master_templates
--
-- Category-level BOM defaults used when creating new BOMs. Replaces the
-- localStorage-only storage (`bom-master-template-<id>` + index) so templates
-- survive browser switches and every user sees the same templates.
--
-- The `data` column holds the template body (processes + materials + WIP
-- items) as JSON. Schema is already an evolving shape on the client; keeping
-- it opaque here avoids split-brain migrations when new fields land. Only
-- fields the server needs to index (category / moduleKey / isDefault) are
-- split out as columns.
-- ============================================================================

CREATE TABLE bom_master_templates (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('BEDFRAME','SOFA')),
  label TEXT NOT NULL,
  moduleKey TEXT,                -- Sofa: matches Product.sizeCode (e.g., "1A(LHF)"). NULL for BEDFRAME default.
  isDefault INTEGER NOT NULL DEFAULT 0,  -- Category fallback when moduleKey doesn't match.
  data TEXT NOT NULL,            -- JSON: { l1Processes: [...], l1Materials: [...], wipItems: [...] }
  updatedAt TEXT NOT NULL
);

CREATE INDEX idx_bom_master_templates_category
  ON bom_master_templates(category);

-- Only one default per category.
CREATE UNIQUE INDEX idx_bom_master_templates_one_default_per_cat
  ON bom_master_templates(category)
  WHERE isDefault = 1;
