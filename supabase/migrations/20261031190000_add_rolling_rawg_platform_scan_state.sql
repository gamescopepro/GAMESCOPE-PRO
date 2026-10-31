ALTER TABLE public.steam_sync_state
  ADD COLUMN IF NOT EXISTS rawg_playstation_page integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rawg_xbox_page integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_rawg_platform_scan_at timestamptz;

UPDATE public.steam_sync_state
SET rawg_playstation_page = CASE
      WHEN rawg_playstation_page < 1 OR rawg_playstation_page > 100 THEN 1
      ELSE rawg_playstation_page
    END,
    rawg_xbox_page = CASE
      WHEN rawg_xbox_page < 1 OR rawg_xbox_page > 100 THEN 1
      ELSE rawg_xbox_page
    END
WHERE id = 'main';
