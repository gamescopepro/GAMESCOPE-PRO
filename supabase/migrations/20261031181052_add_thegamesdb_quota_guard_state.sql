alter table public.steam_sync_state
  add column if not exists thegamesdb_pause_until timestamptz,
  add column if not exists thegamesdb_remaining_allowance integer;
