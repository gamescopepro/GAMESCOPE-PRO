ALTER TABLE public.steam_sync_state
  ADD COLUMN IF NOT EXISTS rawg_metadata_cursor text;
