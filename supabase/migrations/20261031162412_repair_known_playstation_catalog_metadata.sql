-- Repair nine verified PlayStation catalogue records that were missing
-- platform metadata, and ensure known release dates have a matching status.
-- The platform update is guarded so owner edits are never overwritten.

WITH repairs(id, platforms, publisher) AS (
  VALUES
    ('rawg_3387','PlayStation 4','Sony Computer Entertainment • FromSoftware'),
    ('rawg_3631','PlayStation 4','Sony Computer Entertainment • Sucker Punch Productions'),
    ('rawg_2553','PlayStation 4','Sony Computer Entertainment • Insomniac Games'),
    ('rawg_3990','PlayStation 3','Sony Computer Entertainment • Naughty Dog'),
    ('rawg_51325','PlayStation 4','Sony Interactive Entertainment • Naughty Dog'),
    ('rawg_3636','PlayStation 4','Sony Computer Entertainment • Naughty Dog'),
    ('rawg_5687','PlayStation 4','Sony Computer Entertainment • SCE Japan Studio'),
    ('rawg_5703','PlayStation 3','Sony Computer Entertainment • Naughty Dog'),
    ('rawg_2462','PlayStation 4','Sony Interactive Entertainment • Naughty Dog')
)
UPDATE public.site_catalog AS c
SET platforms = r.platforms,
    publisher = COALESCE(NULLIF(BTRIM(c.publisher), ''), r.publisher),
    updated_at = now()
FROM repairs AS r
WHERE c.id = r.id
  AND (c.platforms IS NULL OR BTRIM(c.platforms) = '' OR c.platforms = 'نامشخص');

UPDATE public.site_catalog
SET release_status = CASE
      WHEN release_date > CURRENT_DATE THEN 'upcoming'
      ELSE 'released'
    END,
    updated_at = now()
WHERE release_date IS NOT NULL
  AND release_status = 'unknown';
