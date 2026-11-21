-- ============================================================
--  Subscription gating (tamper-proof, server-enforced).
--  A client can read/write their data ONLY while their subscription
--  (profiles.access_until) is in the future. Enforced in Postgres RLS,
--  so no app (desktop, website or mobile), tampered or not, can bypass it.
--
--  SAFE TO RUN ONCE on the live database. It backfills every existing
--  client with 1 year of access first, so nobody is locked out.
--  Wrapped in a transaction: if anything fails, NOTHING changes.
-- ============================================================
begin;

-- 1) Subscription-expiry column (separate from the mobile add-on's mobile_until).
alter table public.profiles add column if not exists access_until timestamptz;

-- 2) Make sure every current client (anyone who has a settings row) has a profile,
--    then give every existing client a year of access so NO ONE is locked out today.
insert into public.profiles (owner, business_name, access_until)
select s.owner, '', now() + interval '365 days'
from public.settings s
where s.owner is not null
  and not exists (select 1 from public.profiles p where p.owner = s.owner)
on conflict (owner) do nothing;

update public.profiles
   set access_until = now() + interval '365 days'
 where access_until is null;

-- the base owner keeps access forever
update public.profiles
   set access_until = timestamptz '2099-12-31 00:00:00+00'
 where nullif(current_setting('app.base_owner', true), '') is not null
   and owner = nullif(current_setting('app.base_owner', true), '')::uuid;

-- 3) The gate. Runs as definer so it can read admins/profiles past RLS.
create or replace function public.has_access() returns boolean
language sql security definer stable set search_path = public as $$
  select
    exists (select 1 from public.admins a where a.uid = auth.uid())
    or exists (select 1 from public.profiles p
               where p.owner = auth.uid()
                 and p.access_until is not null
                 and p.access_until > now());
$$;
grant execute on function public.has_access() to authenticated;

-- 4) Re-create every client-data policy to ALSO require an active subscription.
--    (profiles stays readable so the app can show the expiry / "renew" message.)
drop policy if exists "parties_own" on public.parties;
create policy "parties_own" on public.parties for all to authenticated
  using (owner = auth.uid() and public.has_access())
  with check (owner = auth.uid() and public.has_access());

drop policy if exists "entries_own" on public.entries;
create policy "entries_own" on public.entries for all to authenticated
  using (owner = auth.uid() and public.has_access())
  with check (owner = auth.uid() and public.has_access());

drop policy if exists "closings_own" on public.closings;
create policy "closings_own" on public.closings for all to authenticated
  using (owner = auth.uid() and public.has_access())
  with check (owner = auth.uid() and public.has_access());

drop policy if exists "settings_own" on public.settings;
create policy "settings_own" on public.settings for all to authenticated
  using (owner = auth.uid() and public.has_access())
  with check (owner = auth.uid() and public.has_access());

drop policy if exists "backups_own" on public.backups;
create policy "backups_own" on public.backups for all to authenticated
  using (owner = auth.uid() and public.has_access())
  with check (owner = auth.uid() and public.has_access());

drop policy if exists "trading_sessions_own" on public.trading_sessions;
create policy "trading_sessions_own" on public.trading_sessions for all to authenticated
  using (owner = auth.uid() and public.has_access())
  with check (owner = auth.uid() and public.has_access());

drop policy if exists "trading_entries_own" on public.trading_entries;
create policy "trading_entries_own" on public.trading_entries for all to authenticated
  using (owner = auth.uid() and public.has_access())
  with check (owner = auth.uid() and public.has_access());

drop policy if exists "match_sessions_own" on public.match_sessions;
create policy "match_sessions_own" on public.match_sessions for all to authenticated
  using (owner = auth.uid() and public.has_access())
  with check (owner = auth.uid() and public.has_access());

drop policy if exists "session_bets_own" on public.session_bets;
create policy "session_bets_own" on public.session_bets for all to authenticated
  using (owner = auth.uid() and public.has_access())
  with check (owner = auth.uid() and public.has_access());

commit;

-- Done. To TEST on one account: set its access to the past and confirm it sees nothing:
--   update public.profiles set access_until = now() - interval '1 day' where owner = '<that user uid>';
-- then restore with the admin panel's "+1 year" button.
