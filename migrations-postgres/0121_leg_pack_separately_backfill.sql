-- ---------------------------------------------------------------------------
-- 0121_leg_pack_separately_backfill.sql (Postgres)
--
-- Feature: "Pack leg separately" checkbox in the Product Catalog.
--
-- A leg is represented as a LEG-HEIGHT OPTION inside the `variants-config`
-- blob (kv_config) under `legHeights` (bedframe / divan) and `sofaLegHeights`
-- (sofa). Each option is { value, priceSen } and now also carries an optional
-- boolean `packSeparately`. There is NO leg row in the `products` table and no
-- typed column to add — both the live blob (kv_config.value) and its history
-- snapshots (maintenance_config_history.config) are schemaless TEXT JSON. So
-- this migration is a DATA BACKFILL, not a DDL change.
--
-- It stamps `packSeparately` onto every existing leg-height option that does
-- not already have it, using the legacy FG-sticker rule the flag replaces:
-- a leg taller than 1 inch packed separately, 1" / No Leg did not. After this
-- runs, existing prod / staging configs carry explicit flags that reproduce
-- the exact behaviour they had before the feature shipped.
--
-- Idempotent: only options missing the key are touched (the WHERE NOT ...?
-- guards), so re-running is a no-op. Safe on rows that have no leg lists.
-- ---------------------------------------------------------------------------

-- Helper expression: given a leg-height option object, return it with
-- `packSeparately` added when missing. The default mirrors ">1 inch packs
-- separately": parse the leading number out of values like '4"' / '10.5"',
-- compare to 1. 'No Leg' and unparseable values default to false.
--   regexp_replace(value, '[^0-9.].*$', '') strips the trailing inch mark and
--   anything after the first non-numeric char, leaving '4' / '10.5' / ''.

-- --- Live blob: kv_config('variants-config' and customer variants) ----------
UPDATE kv_config
SET value = (
  SELECT jsonb_set(
           jsonb_set(
             blob,
             '{legHeights}',
             COALESCE((
               SELECT jsonb_agg(
                 CASE
                   WHEN opt ? 'packSeparately' THEN opt
                   ELSE opt || jsonb_build_object(
                     'packSeparately',
                     COALESCE(NULLIF(regexp_replace(opt->>'value', '[^0-9.].*$', ''), '')::numeric, 0) > 1
                   )
                 END
               )
               FROM jsonb_array_elements(blob->'legHeights') AS opt
             ), blob->'legHeights'),
             false
           ),
           '{sofaLegHeights}',
           COALESCE((
             SELECT jsonb_agg(
               CASE
                 WHEN opt ? 'packSeparately' THEN opt
                 ELSE opt || jsonb_build_object(
                   'packSeparately',
                   COALESCE(NULLIF(regexp_replace(opt->>'value', '[^0-9.].*$', ''), '')::numeric, 0) > 1
                 )
               END
             )
             FROM jsonb_array_elements(blob->'sofaLegHeights') AS opt
           ), blob->'sofaLegHeights'),
           false
         )::text
  FROM (SELECT value::jsonb AS blob) AS j
)
WHERE (key = 'variants-config' OR key LIKE 'variants-config:%')
  AND value IS NOT NULL
  AND value <> ''
  AND (
    -- Only touch rows that have at least one un-flagged leg option, so the
    -- migration is idempotent and skips already-migrated blobs.
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(value::jsonb->'legHeights', '[]'::jsonb)) o
      WHERE NOT (o ? 'packSeparately')
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(value::jsonb->'sofaLegHeights', '[]'::jsonb)) o
      WHERE NOT (o ? 'packSeparately')
    )
  );

-- --- History snapshots: maintenance_config_history.config -------------------
-- Backfill the same flag into every historical snapshot so the per-row /
-- effective-dated history views stay consistent with the live blob.
UPDATE maintenance_config_history
SET config = (
  SELECT jsonb_set(
           jsonb_set(
             blob,
             '{legHeights}',
             COALESCE((
               SELECT jsonb_agg(
                 CASE
                   WHEN opt ? 'packSeparately' THEN opt
                   ELSE opt || jsonb_build_object(
                     'packSeparately',
                     COALESCE(NULLIF(regexp_replace(opt->>'value', '[^0-9.].*$', ''), '')::numeric, 0) > 1
                   )
                 END
               )
               FROM jsonb_array_elements(blob->'legHeights') AS opt
             ), blob->'legHeights'),
             false
           ),
           '{sofaLegHeights}',
           COALESCE((
             SELECT jsonb_agg(
               CASE
                 WHEN opt ? 'packSeparately' THEN opt
                 ELSE opt || jsonb_build_object(
                   'packSeparately',
                   COALESCE(NULLIF(regexp_replace(opt->>'value', '[^0-9.].*$', ''), '')::numeric, 0) > 1
                 )
               END
             )
             FROM jsonb_array_elements(blob->'sofaLegHeights') AS opt
           ), blob->'sofaLegHeights'),
           false
         )::text
  FROM (SELECT config::jsonb AS blob) AS j
)
WHERE config IS NOT NULL
  AND config <> ''
  AND (
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(config::jsonb->'legHeights', '[]'::jsonb)) o
      WHERE NOT (o ? 'packSeparately')
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(config::jsonb->'sofaLegHeights', '[]'::jsonb)) o
      WHERE NOT (o ? 'packSeparately')
    )
  );
