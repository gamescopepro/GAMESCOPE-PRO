alter table public.steam_sync_queue
  add column if not exists processed_at timestamptz;

create index if not exists steam_sync_queue_pending_idx
  on public.steam_sync_queue (queued_at, appid)
  where processed_at is null;

