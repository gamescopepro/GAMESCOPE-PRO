alter table public.steam_sync_state
  add column if not exists thegamesdb_cursor text,
  add column if not exists last_thegamesdb_fetch_at timestamptz;
