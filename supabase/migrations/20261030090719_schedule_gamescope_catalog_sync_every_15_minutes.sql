do $$
begin
  if not exists (select 1 from vault.secrets where name = 'gamescope_project_url') then
    perform vault.create_secret(
      'https://axwjiwpwqoykvcbumixy.supabase.co',
      'gamescope_project_url',
      'Supabase project URL used by the GAMESCOPE catalog scheduler'
    );
  end if;

  if not exists (select 1 from vault.secrets where name = 'gamescope_publishable_key') then
    perform vault.create_secret(
      'sb_publishable_QUBqbgVxbEpXlseeCIqeSA_BxPeDou-',
      'gamescope_publishable_key',
      'Public API key used only as the gateway apikey header for the scheduled Edge Function'
    );
  end if;
end
$$;

do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname = 'gamescope-catalog-sync';
  if existing_job is not null then perform cron.unschedule(existing_job); end if;

  perform cron.schedule(
    'gamescope-catalog-sync',
    '*/15 * * * *',
    $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'gamescope_project_url')
          || '/functions/v1/catalog-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'gamescope_publishable_key'),
          'x-gamescope-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'gamescope_catalog_cron_token')
        ),
        body := jsonb_build_object('trigger', 'cron', 'scheduled_at', now()),
        timeout_milliseconds := 120000
      );
    $job$
  );
end
$$;
