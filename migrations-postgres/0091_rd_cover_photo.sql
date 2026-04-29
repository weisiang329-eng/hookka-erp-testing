-- ============================================================================
-- Migration 0091 — R&D Projects: cover photo
--
-- Adds a single nullable text column for an R&D project's cover photo. The
-- value is a data URL (image/jpeg) produced by the off-main-thread
-- compressImage helper — same pattern as service-case issuePhotos. We don't
-- store binary or upload to R2 separately; cover photos are small (max 1280px,
-- ~150-300 KB after JPEG compression) and the existing stack already accepts
-- data URLs in TEXT columns.
--
-- Cover photos give the operator a glanceable thumbnail of "what this project
-- is about" — a sofa being designed, a competitor product being cloned —
-- without having to read the description.
-- ============================================================================

ALTER TABLE rd_projects ADD COLUMN IF NOT EXISTS cover_photo_url TEXT;
