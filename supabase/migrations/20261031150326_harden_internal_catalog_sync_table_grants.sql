-- Keep internal catalog synchronization state and queue tables inaccessible
-- to public and signed-in client roles. The Edge Function uses service_role.
REVOKE ALL PRIVILEGES ON TABLE public.steam_sync_queue, public.steam_sync_state
  FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.steam_sync_queue, public.steam_sync_state
  TO service_role;
