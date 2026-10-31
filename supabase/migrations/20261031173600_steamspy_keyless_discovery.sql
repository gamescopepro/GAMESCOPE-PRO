alter table public.steam_sync_state
  add column if not exists steamspy_page integer not null default 0
    check (steamspy_page >= 0),
  add column if not exists last_steamspy_fetch_at timestamptz;
