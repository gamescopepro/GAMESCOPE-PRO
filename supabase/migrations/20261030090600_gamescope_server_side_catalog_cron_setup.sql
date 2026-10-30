create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create extension if not exists pg_net with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.gamescope_catalog_cron_guard (
  id boolean primary key default true check (id),
  token_hash bytea not null,
  updated_at timestamptz not null default now()
);

revoke all on table private.gamescope_catalog_cron_guard from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'gamescope_catalog_cron_token') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'gamescope_catalog_cron_token',
      'Authentication token for the server-side GAMESCOPE catalog cron job'
    );
  end if;
end
$$;

insert into private.gamescope_catalog_cron_guard (id, token_hash)
select true, extensions.digest(decrypted_secret, 'sha256')
from vault.decrypted_secrets
where name = 'gamescope_catalog_cron_token'
on conflict (id) do update
set token_hash = excluded.token_hash,
    updated_at = now();

create or replace function public.verify_gamescope_catalog_cron_token(p_token text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.gamescope_catalog_cron_guard
    where id = true
      and token_hash = extensions.digest(coalesce(p_token, ''), 'sha256')
  );
$$;

revoke all on function public.verify_gamescope_catalog_cron_token(text) from public, anon, authenticated;
grant execute on function public.verify_gamescope_catalog_cron_token(text) to service_role;
