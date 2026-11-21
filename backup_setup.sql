-- ============================================================================
-- Shree Shyam Book — server-side dated backups (recovery)
-- Run this ONCE in the Supabase SQL editor (after database.sql).
-- Creates a backups table, a daily snapshot that keeps 10 days per client,
-- and schedules it to run automatically every day with pg_cron.
-- ============================================================================

-- 1) Where backups live. One JSON snapshot per client per day.
create table if not exists public.client_backups (
  id         bigint generated always as identity primary key,
  owner      uuid not null,
  taken_at   timestamptz not null default now(),
  day        date not null default (now() at time zone 'utc')::date,
  label      text,
  data       jsonb not null
);
create index if not exists client_backups_owner_taken
  on public.client_backups(owner, taken_at desc);

-- Each client sees ONLY their own backups; may insert their own (app self-backup
-- on logout). No update/delete for ordinary users. The owner/admin reaches any
-- client's backups only through the service-role Edge Function.
alter table public.client_backups enable row level security;
drop policy if exists cb_sel on public.client_backups;
create policy cb_sel on public.client_backups for select using (owner = auth.uid());
drop policy if exists cb_ins on public.client_backups;
create policy cb_ins on public.client_backups for insert with check (owner = auth.uid());

-- table privileges (RLS still restricts rows to the owner)
grant select, insert on public.client_backups to authenticated;
grant all on public.client_backups to service_role;

-- 2) Snapshot one client into a dated backup row, keep the 10 most recent DAYS.
create or replace function public.take_client_backup(o uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  snap   jsonb;
  newid  bigint;
begin
  snap := jsonb_build_object(
    '_format', 'shreeshyam-backup-v1',
    '_owner', o,
    '_exported_at', now(),
    'parties',          coalesce((select jsonb_agg(to_jsonb(t)) from parties t          where t.owner=o), '[]'::jsonb),
    'closings',         coalesce((select jsonb_agg(to_jsonb(t)) from closings t         where t.owner=o), '[]'::jsonb),
    'entries',          coalesce((select jsonb_agg(to_jsonb(t)) from entries t          where t.owner=o), '[]'::jsonb),
    'trading_sessions', coalesce((select jsonb_agg(to_jsonb(t)) from trading_sessions t where t.owner=o), '[]'::jsonb),
    'match_sessions',   coalesce((select jsonb_agg(to_jsonb(t)) from match_sessions t   where t.owner=o), '[]'::jsonb),
    'trading_entries',  coalesce((select jsonb_agg(to_jsonb(t)) from trading_entries t  where t.owner=o), '[]'::jsonb),
    'session_bets',     coalesce((select jsonb_agg(to_jsonb(t)) from session_bets t     where t.owner=o), '[]'::jsonb),
    'settings',         coalesce((select jsonb_agg(to_jsonb(t)) from settings t         where t.owner=o), '[]'::jsonb)
  );

  -- one backup per day: replace today's if it already exists
  delete from public.client_backups
   where owner = o and day = (now() at time zone 'utc')::date;

  insert into public.client_backups(owner, label, data)
  values (o, to_char(now() at time zone 'utc', 'YYYY-MM-DD'), snap)
  returning id into newid;

  -- keep only the 10 most recent days for this client
  delete from public.client_backups cb
   where cb.owner = o
     and cb.id not in (
       select id from public.client_backups
        where owner = o order by taken_at desc limit 10
     );

  return newid;
end $$;

-- 3) Snapshot EVERY client (used by the daily schedule and the "Back up all now" button).
create or replace function public.take_all_backups()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare r record; n integer := 0;
begin
  for r in select owner from public.profiles loop
    perform public.take_client_backup(r.owner);
    n := n + 1;
  end loop;
  return n;
end $$;

-- 4) A client can back up THEIR OWN data (used by the web app on logout).
create or replace function public.backup_my_data()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return public.take_client_backup(auth.uid());
end $$;

-- 5) Lock down who can run what.
revoke all on function public.take_client_backup(uuid) from public, anon, authenticated;
revoke all on function public.take_all_backups()        from public, anon, authenticated;
grant execute on function public.take_client_backup(uuid) to service_role;
grant execute on function public.take_all_backups()        to service_role;
grant execute on function public.backup_my_data()          to authenticated;

-- 6) Daily automatic backup at 20:00 UTC via pg_cron.
--    NOTE: first enable the "pg_cron" extension once in the Supabase dashboard
--    (Database -> Extensions -> search pg_cron -> Enable), then run this file.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('daily-client-backup')
      where exists (select 1 from cron.job where jobname = 'daily-client-backup');
    perform cron.schedule('daily-client-backup', '0 20 * * *', $cron$ select public.take_all_backups(); $cron$);
  else
    raise notice 'pg_cron is not enabled yet — enable it in Database > Extensions, then re-run this file to schedule the daily backup.';
  end if;
end $$;

-- Take one snapshot right now so every client immediately has a restore point.
select public.take_all_backups();
