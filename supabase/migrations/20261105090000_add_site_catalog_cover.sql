alter table public.site_catalog
  add column if not exists cover text;

comment on column public.site_catalog.cover is
  'Optional external game cover image URL from the catalog provider or storefront.';
