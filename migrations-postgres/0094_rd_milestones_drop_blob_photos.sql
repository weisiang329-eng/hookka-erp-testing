-- ---------------------------------------------------------------------------
-- 0094_rd_milestones_drop_blob_photos.sql
--
-- Strip stale "blob:..." URL entries from the milestones JSON column on
-- rd_projects. These came from the pre-1e4546d photo upload path which
-- used URL.createObjectURL() — the resulting blob: URLs are scoped to the
-- browser tab that created them and become 404s as soon as the tab closes
-- or the page reloads. They have NO server-side bytes; nothing is recoverable.
--
-- Commit 1e4546d switched the upload path to compressImage() which produces
-- persistent JPEG data URLs, so all NEW uploads survive reload. This
-- migration cleans up the lingering broken blob: entries from before that
-- fix shipped, removing them from each milestone's photos array so the UI
-- stops trying to render them.
--
-- Idempotent: only matches rows whose milestones JSON still contains the
-- string "blob:". Re-running is a no-op once all rows are cleaned.
-- ---------------------------------------------------------------------------

-- Strip each "blob:..." string entry (with optional preceding comma) from
-- the JSON. We operate on the TEXT representation because milestones is
-- stored as JSON-as-text, not JSONB. The two passes handle both
-- "[blob:..., realUrl]" (leading entry) and "[realUrl, blob:..., ...]"
-- (middle / trailing entries) — first pass nukes ',blob:...' patterns,
-- second pass nukes 'blob:...,' and bare 'blob:...' patterns.
UPDATE rd_projects
   SET milestones = regexp_replace(
                      regexp_replace(milestones, ',\s*"blob:[^"]*"', '', 'g'),
                      '"blob:[^"]*"\s*,?', '', 'g'
                    )
 WHERE milestones LIKE '%blob:%';

-- Cleanup: any [, "x"] artifacts left by the first regex collapse them
-- back to valid JSON arrays.
UPDATE rd_projects
   SET milestones = regexp_replace(milestones, '\[\s*,', '[', 'g')
 WHERE milestones LIKE '%[%,%';
