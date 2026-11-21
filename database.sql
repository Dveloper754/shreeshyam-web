-- ============================================================
--  Simple Accounting — complete database setup (Supabase)
--  Paste this WHOLE file into the Supabase SQL Editor and click Run.
--  It is safe to run on a fresh project OR to re-run on an existing one
--  (it only adds what is missing and refreshes the views/functions).
--
--  MULTI-USER ISOLATION (v2): every table carries an `owner` column and
--  Row Level Security limits each logged-in user to ONLY their own rows.
--  Running this on an existing single-user database migrates it in place:
--  all existing rows are assigned to one base owner (the 'owner@books.local'
--  login if present, otherwise the first/oldest auth user).
-- ============================================================

create extension if not exists pgcrypto;

-- Work out which user should own the EXISTING (pre-migration) rows, and stash
-- it in a session setting we can reference from the UPDATE statements below.
do $$
declare v_base uuid;
begin
  select id into v_base from auth.users where email = 'owner@books.local' limit 1;
  if v_base is null then select id into v_base from auth.users order by created_at asc limit 1; end if;
  perform set_config('app.base_owner', coalesce(v_base::text, ''), false);
end $$;

-- ---------- Tables ----------
create table if not exists public.parties (
    id              uuid primary key default gen_random_uuid(),
    name            text not null,
    phone           text not null default '',
    opening_balance numeric(14,2) not null default 0,
    notes           text not null default '',
    created_at      timestamptz not null default now()
);
alter table public.parties add column if not exists is_capital boolean not null default false;
alter table public.parties add column if not exists config jsonb not null default '{}'::jsonb;
alter table public.parties add column if not exists owner uuid;
update public.parties set owner = nullif(current_setting('app.base_owner', true), '')::uuid where owner is null;
alter table public.parties alter column owner set default auth.uid();
-- party names are unique PER OWNER (two different books may both have "MA").
drop index if exists public.parties_name_unique;
create unique index if not exists parties_name_owner_unique on public.parties (owner, lower(name));

create table if not exists public.closings (
    id              uuid primary key default gen_random_uuid(),
    party_id        uuid not null references public.parties(id) on delete cascade,
    closed_on       date not null default current_date,
    opening_before  numeric(14,2) not null,
    closing_balance numeric(14,2) not null,
    created_at      timestamptz not null default now()
);
create index if not exists closings_party on public.closings (party_id);
alter table public.closings add column if not exists owner uuid;
update public.closings set owner = nullif(current_setting('app.base_owner', true), '')::uuid where owner is null;
alter table public.closings alter column owner set default auth.uid();

create table if not exists public.entries (
    id          uuid primary key default gen_random_uuid(),
    party_id    uuid not null references public.parties(id) on delete cascade,
    entry_date  date not null default current_date,
    type        text not null check (type in ('received','paid')),
    amount      numeric(14,2) not null check (amount > 0),
    mode        text not null default 'cash',
    reference   text not null default '',
    remark      text not null default '',
    created_at  timestamptz not null default now()
);
alter table public.entries add column if not exists counterparty text not null default '';
alter table public.entries add column if not exists archived    boolean not null default false;
alter table public.entries add column if not exists deleted     boolean not null default false;
alter table public.entries add column if not exists transfer_id uuid;
alter table public.entries add column if not exists period_id   uuid references public.closings(id) on delete set null;
alter table public.entries add column if not exists created_by  uuid;
alter table public.entries add column if not exists owner uuid;
update public.entries set owner = coalesce(created_by, nullif(current_setting('app.base_owner', true), '')::uuid) where owner is null;
alter table public.entries alter column owner set default auth.uid();

create index if not exists entries_party    on public.entries (party_id);
create index if not exists entries_date     on public.entries (entry_date);
create index if not exists entries_archived on public.entries (party_id, archived);

-- settings is now ONE ROW PER USER (was a single shared row with id = 1).
create table if not exists public.settings (
    id              int default 1,
    opening_capital numeric(14,2) not null default 0
);
alter table public.settings add column if not exists auto_backup  boolean not null default true;
alter table public.settings add column if not exists capital_name text not null default 'Capital Account';
alter table public.settings add column if not exists agents   jsonb not null default '[]'::jsonb;  -- agents master list
alter table public.settings add column if not exists partners jsonb not null default '[]'::jsonb;  -- global partners master list
alter table public.settings add column if not exists owner uuid;
-- migrate the old shared single row to the base owner, then drop the id=1 lock.
update public.settings set owner = nullif(current_setting('app.base_owner', true), '')::uuid where owner is null;
alter table public.settings drop constraint if exists settings_pkey;
alter table public.settings drop constraint if exists settings_id_check;
alter table public.settings alter column id drop not null;
alter table public.settings alter column id drop default;
alter table public.settings alter column owner set default auth.uid();
create unique index if not exists settings_owner_uniq on public.settings (owner);
-- make sure the base owner has a settings row (fresh projects: none yet, created per-user by the app on first login)
insert into public.settings (opening_capital, owner)
select 0, nullif(current_setting('app.base_owner', true), '')::uuid
where nullif(current_setting('app.base_owner', true), '') is not null
  and not exists (select 1 from public.settings where owner = nullif(current_setting('app.base_owner', true), '')::uuid);

-- ---------- Views (security_invoker: each caller sees only their own rows) ----------
drop view if exists public.party_balances cascade;
drop view if exists public.party_ledger   cascade;
drop view if exists public.capital_account cascade;
drop view if exists public.capital_ledger  cascade;

create or replace view public.party_balances with (security_invoker = true) as
select
    p.id, p.name, p.phone, p.opening_balance, p.notes, p.created_at, p.is_capital, p.config,
    coalesce(sum(e.amount) filter (where e.type='received' and not e.archived and not e.deleted), 0) as total_received,
    coalesce(sum(e.amount) filter (where e.type='paid'     and not e.archived and not e.deleted), 0) as total_paid,
    p.opening_balance
      + coalesce(sum(e.amount) filter (where e.type='received' and not e.archived and not e.deleted), 0)
      - coalesce(sum(e.amount) filter (where e.type='paid'     and not e.archived and not e.deleted), 0) as balance,
    count(e.id) filter (where not e.archived and not e.deleted) as entry_count
from public.parties p
left join public.entries e on e.party_id = p.id
group by p.id;

create or replace view public.party_ledger with (security_invoker = true) as
select
    e.id, e.party_id, p.name as party_name, e.entry_date, e.type, e.amount,
    e.mode, e.reference, e.remark, e.counterparty, e.deleted, e.created_at,
    p.opening_balance
      + sum(case when e.deleted then 0 when e.type='received' then e.amount else -e.amount end)
        over (partition by e.party_id order by e.entry_date, e.created_at, e.id
              rows between unbounded preceding and current row) as running_balance
from public.entries e
join public.parties p on p.id = e.party_id
where not e.archived;

create or replace view public.capital_account with (security_invoker = true) as
select
    s.opening_capital,
    (select coalesce(sum(amount),0) from public.entries where type='received' and not deleted) as total_received,
    (select coalesce(sum(amount),0) from public.entries where type='paid'     and not deleted) as total_paid,
    s.opening_capital
      + (select coalesce(sum(amount),0) from public.entries where type='received' and not deleted)
      - (select coalesce(sum(amount),0) from public.entries where type='paid'     and not deleted) as balance
from public.settings s where s.owner = auth.uid();

create or replace view public.capital_ledger with (security_invoker = true) as
select
    e.id, e.party_id, p.name as party_name, e.entry_date, e.type, e.amount,
    e.mode, e.reference, e.remark, e.counterparty, e.archived, e.created_at,
    (select opening_capital from public.settings where owner = auth.uid())
      + sum(case when e.type='received' then e.amount else -e.amount end)
        over (order by e.entry_date, e.created_at, e.id
              rows between unbounded preceding and current row) as running_balance
from public.entries e
join public.parties p on p.id = e.party_id
where not e.deleted;

-- ---------- Functions (security invoker: run as the caller, so RLS + auth.uid() apply) ----------
create or replace function public.add_entry(
    p_party text, p_type text, p_amount numeric,
    p_date date default current_date, p_mode text default 'cash',
    p_reference text default '', p_remark text default ''
) returns public.entries language plpgsql security invoker as $$
declare v_party_id uuid; v_row public.entries;
begin
    if p_type not in ('received','paid') then raise exception 'type must be received or paid'; end if;
    if p_amount is null or p_amount <= 0 then raise exception 'amount must be greater than 0'; end if;
    select id into v_party_id from public.parties where lower(name) = lower(trim(p_party));
    if v_party_id is null then
        insert into public.parties (name) values (trim(p_party)) returning id into v_party_id;
    end if;
    insert into public.entries (party_id, entry_date, type, amount, mode, reference, remark, created_by)
    values (v_party_id, coalesce(p_date, current_date), p_type, p_amount,
            coalesce(p_mode,'cash'), coalesce(p_reference,''), coalesce(p_remark,''), auth.uid())
    returning * into v_row;
    return v_row;
end; $$;

create or replace function public.transfer(
    p_from text, p_to text, p_amount numeric,
    p_date date default current_date, p_remark text default ''
) returns uuid language plpgsql security invoker as $$
declare
    v_from uuid; v_to uuid; v_tid uuid := gen_random_uuid();
    v_fromname text := trim(p_from); v_toname text := trim(p_to);
begin
    if p_amount is null or p_amount <= 0 then raise exception 'amount must be greater than 0'; end if;
    if v_fromname = '' or v_toname = '' then raise exception 'both From and To parties are required'; end if;
    if lower(v_fromname) = lower(v_toname) then raise exception 'From and To must be different parties'; end if;
    select id into v_from from public.parties where lower(name)=lower(v_fromname);
    if v_from is null then insert into public.parties (name) values (v_fromname) returning id into v_from; end if;
    select id into v_to from public.parties where lower(name)=lower(v_toname);
    if v_to is null then insert into public.parties (name) values (v_toname) returning id into v_to; end if;
    insert into public.entries (party_id, entry_date, type, amount, mode, remark, counterparty, transfer_id, created_by)
    values (v_from, coalesce(p_date, current_date), 'received', p_amount, 'transfer', coalesce(p_remark,''), v_toname, v_tid, auth.uid());
    insert into public.entries (party_id, entry_date, type, amount, mode, remark, counterparty, transfer_id, created_by)
    values (v_to, coalesce(p_date, current_date), 'paid', p_amount, 'transfer', coalesce(p_remark,''), v_fromname, v_tid, auth.uid());
    return v_tid;
end; $$;

create or replace function public.monday_final(
    p_party uuid, p_closed_on date default current_date
) returns public.closings language plpgsql security invoker as $$
declare v_open numeric(14,2); v_close numeric(14,2); v_row public.closings;
begin
    select opening_balance into v_open from public.parties where id = p_party for update;
    if v_open is null then raise exception 'party not found'; end if;
    select v_open
         + coalesce(sum(amount) filter (where type='received' and not archived and not deleted), 0)
         - coalesce(sum(amount) filter (where type='paid'     and not archived and not deleted), 0)
      into v_close from public.entries where party_id = p_party;
    insert into public.closings (party_id, closed_on, opening_before, closing_balance)
    values (p_party, coalesce(p_closed_on, current_date), v_open, v_close) returning * into v_row;
    update public.entries set archived = true, period_id = v_row.id where party_id = p_party and not archived;
    update public.parties set opening_balance = v_close where id = p_party;
    return v_row;
end; $$;

-- "Clear All Balance": clears ONLY the match & session saudas.
-- Keeps every client ledger entry, every party, and all balances.
create or replace function public.entries_reset() returns void language plpgsql security invoker as $$
begin
    delete from public.trading_sessions where true;   -- cascades to match_sessions, trading_entries, session_bets
end; $$;

-- "Clear Programe": erases everything (ledger, parties, matches & saudas).
create or replace function public.full_reset() returns void language plpgsql security invoker as $$
begin
    delete from public.entries  where true;
    delete from public.closings where true;
    delete from public.parties where true;
    delete from public.trading_sessions where true;   -- cascades to match_sessions, trading_entries, session_bets
    update public.settings set opening_capital = 0, agents = '[]'::jsonb, partners = '[]'::jsonb where owner = auth.uid();
end; $$;

-- "Clear Data / Keep Cl Balance": clears all ledger entries and all matches & saudas,
-- but keeps every party and rolls their closing balance forward into opening_balance
-- (a party with a zero balance still stays).
create or replace function public.reset_keep_parties() returns void language plpgsql security invoker as $$
begin
    update public.settings s set opening_capital =
        s.opening_capital
        + coalesce((select sum(amount) from public.entries where type='received' and not deleted), 0)
        - coalesce((select sum(amount) from public.entries where type='paid'     and not deleted), 0)
    where s.owner = auth.uid();
    update public.parties p set opening_balance =
        p.opening_balance
        + coalesce((select sum(amount) from public.entries e where e.party_id=p.id and e.type='received' and not e.archived and not e.deleted), 0)
        - coalesce((select sum(amount) from public.entries e where e.party_id=p.id and e.type='paid'     and not e.archived and not e.deleted), 0)
    where true;
    delete from public.entries  where true;
    delete from public.closings where true;
    delete from public.trading_sessions where true;   -- cascades to match_sessions, trading_entries, session_bets
end; $$;

-- ---------- Security (Row Level Security — per owner) ----------
alter table public.parties  enable row level security;
alter table public.entries  enable row level security;
alter table public.closings enable row level security;
alter table public.settings enable row level security;

drop policy if exists "parties_auth_all"  on public.parties;
drop policy if exists "entries_auth_all"  on public.entries;
drop policy if exists "closings_auth_all" on public.closings;
drop policy if exists "settings_auth_all" on public.settings;
drop policy if exists "parties_own"  on public.parties;
drop policy if exists "entries_own"  on public.entries;
drop policy if exists "closings_own" on public.closings;
drop policy if exists "settings_own" on public.settings;
create policy "parties_own"  on public.parties  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "entries_own"  on public.entries  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "closings_own" on public.closings for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "settings_own" on public.settings for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

grant select on public.party_balances  to authenticated;
grant select on public.party_ledger     to authenticated;
grant select on public.capital_account  to authenticated;
grant select on public.capital_ledger    to authenticated;
grant select, insert, update, delete on public.settings  to authenticated;
grant select, insert, update, delete on public.parties    to authenticated;
grant select, insert, update, delete on public.entries    to authenticated;
grant select, insert, update, delete on public.closings   to authenticated;
grant execute on function public.add_entry(text, text, numeric, date, text, text, text) to authenticated;
grant execute on function public.transfer(text, text, numeric, date, text) to authenticated;
grant execute on function public.monday_final(uuid, date) to authenticated;
grant execute on function public.entries_reset() to authenticated;
grant execute on function public.full_reset() to authenticated;
grant execute on function public.reset_keep_parties() to authenticated;

-- ============================================================
--  Backup & Restore  (per owner; safe to re-run)
-- ============================================================
-- Ensure the BASE owner has a Capital party (per-user capital is created by the
-- app on each user's first login). Only runs when there is existing data to own.
do $$
declare v_base uuid;
begin
  v_base := nullif(current_setting('app.base_owner', true), '')::uuid;
  if v_base is not null and not exists (select 1 from public.parties where is_capital and owner = v_base) then
    declare v_name text; v_open numeric(14,2);
    begin
      select coalesce(nullif(capital_name, ''), 'Capital Account'), coalesce(opening_capital, 0)
        into v_name, v_open from public.settings where owner = v_base;
      if v_name is null then v_name := 'Capital Account'; v_open := 0; end if;
      if exists (select 1 from public.parties where lower(name) = lower(v_name) and owner = v_base) then
        update public.parties set is_capital = true where lower(name) = lower(v_name) and owner = v_base;
      else
        insert into public.parties (name, opening_balance, is_capital, owner)
        values (v_name, coalesce(v_open, 0), true, v_base);
      end if;
    end;
  end if;
end $$;

create table if not exists public.backups (
    id         uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    kind       text not null default 'manual',
    note       text not null default '',
    data       jsonb not null
);
create index if not exists backups_created on public.backups (created_at desc);
alter table public.backups add column if not exists owner uuid;
update public.backups set owner = nullif(current_setting('app.base_owner', true), '')::uuid where owner is null;
alter table public.backups alter column owner set default auth.uid();

create or replace function public.export_data() returns jsonb
language sql security invoker as $$
  select jsonb_build_object(
    'exported_at', now(),
    'parties',  (select coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) from public.parties p),
    'closings', (select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) from public.closings c),
    'entries',  (select coalesce(jsonb_agg(to_jsonb(e)),'[]'::jsonb) from public.entries e),
    'settings', (select to_jsonb(s) from public.settings s where s.owner = auth.uid())
  );
$$;

create or replace function public.restore_data(p_data jsonb) returns void
language plpgsql security invoker as $$
begin
    delete from public.entries  where true;
    delete from public.closings where true;
    delete from public.parties where true;
    insert into public.parties  select * from jsonb_populate_recordset(null::public.parties,  coalesce(p_data->'parties','[]'::jsonb));
    insert into public.closings select * from jsonb_populate_recordset(null::public.closings, coalesce(p_data->'closings','[]'::jsonb));
    insert into public.entries  select * from jsonb_populate_recordset(null::public.entries,  coalesce(p_data->'entries','[]'::jsonb));
    if p_data ? 'settings' and jsonb_typeof(p_data->'settings') = 'object' then
        update public.settings set
            opening_capital = coalesce((p_data->'settings'->>'opening_capital')::numeric, opening_capital),
            auto_backup     = coalesce((p_data->'settings'->>'auto_backup')::boolean, auto_backup)
        where owner = auth.uid();
    end if;
end; $$;

create or replace function public.create_backup(p_note text default '', p_kind text default 'manual')
returns public.backups language plpgsql security invoker as $$
declare v_row public.backups;
begin
    insert into public.backups (kind, note, data)
    values (coalesce(p_kind,'manual'), coalesce(p_note,''), public.export_data())
    returning * into v_row;
    delete from public.backups
     where id not in (select id from public.backups order by created_at desc limit 30);
    return v_row;
end; $$;

create or replace function public.restore_backup(p_id uuid) returns void
language plpgsql security invoker as $$
declare v jsonb;
begin
    select data into v from public.backups where id = p_id;
    if v is null then raise exception 'backup not found'; end if;
    perform public.restore_data(v);
end; $$;

alter table public.backups enable row level security;
drop policy if exists "backups_auth_all" on public.backups;
drop policy if exists "backups_own" on public.backups;
create policy "backups_own" on public.backups for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

grant select, insert, delete on public.backups to authenticated;
grant execute on function public.export_data() to authenticated;
grant execute on function public.restore_data(jsonb) to authenticated;
grant execute on function public.create_backup(text, text) to authenticated;
grant execute on function public.restore_backup(uuid) to authenticated;

-- ERASE EVERYTHING for the CURRENT user only (RLS scopes the deletes to the caller).
create or replace function public.erase_all() returns void
language plpgsql security invoker as $$
begin
    delete from public.entries  where true;
    delete from public.closings where true;
    delete from public.parties  where true;
    delete from public.backups  where true;
    update public.settings set opening_capital = 0 where owner = auth.uid();
end; $$;
grant execute on function public.erase_all() to authenticated;

-- ============================================================
--  Trading module (team betting)  (per owner; safe to re-run)
-- ============================================================
create table if not exists public.trading_sessions (
    id         uuid primary key default gen_random_uuid(),
    name       text not null default '',
    team1      text not null default '',
    team2      text not null default '',
    type       text not null default '',
    result     text not null default '',
    trade_date date not null default current_date,
    teams      jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now()
);
alter table public.trading_sessions add column if not exists name   text not null default '';
alter table public.trading_sessions add column if not exists team1  text not null default '';
alter table public.trading_sessions add column if not exists team2  text not null default '';
alter table public.trading_sessions add column if not exists type   text not null default '';
alter table public.trading_sessions add column if not exists result text not null default '';
alter table public.trading_sessions add column if not exists owner uuid;
update public.trading_sessions set owner = nullif(current_setting('app.base_owner', true), '')::uuid where owner is null;
alter table public.trading_sessions alter column owner set default auth.uid();
alter table public.trading_sessions add column if not exists tally jsonb not null default '{}'::jsonb;

create table if not exists public.match_sessions (
    id              uuid primary key default gen_random_uuid(),
    match_id        uuid not null references public.trading_sessions(id) on delete cascade,
    name            text not null default '',
    result          text not null default '',
    commission_type text not null default '',
    session_date    date not null default current_date,
    created_at      timestamptz not null default now()
);
create index if not exists match_sessions_match on public.match_sessions(match_id);
alter table public.match_sessions add column if not exists commission_type text not null default '';
alter table public.match_sessions add column if not exists owner uuid;
update public.match_sessions set owner = nullif(current_setting('app.base_owner', true), '')::uuid where owner is null;
alter table public.match_sessions alter column owner set default auth.uid();

create table if not exists public.trading_entries (
    id         uuid primary key default gen_random_uuid(),
    session_id uuid not null references public.trading_sessions(id) on delete cascade,
    qty        numeric(16,2) not null,
    rate       numeric(16,4) not null,
    mode       text not null check (mode in ('K','L')),
    team       text not null default '',
    party_name text not null default '',
    modified   boolean not null default false,
    deleted    boolean not null default false,
    created_at timestamptz not null default now()
);
create index if not exists trading_entries_session on public.trading_entries(session_id);
alter table public.trading_entries add column if not exists owner uuid;
update public.trading_entries set owner = nullif(current_setting('app.base_owner', true), '')::uuid where owner is null;
alter table public.trading_entries alter column owner set default auth.uid();

create table if not exists public.session_bets (
    id         uuid primary key default gen_random_uuid(),
    session_id uuid not null references public.match_sessions(id) on delete cascade,
    amount     numeric(16,2) not null,
    rate       numeric(16,4) not null,
    run        integer not null,
    mode       text not null check (mode in ('K','L')),
    party_name text not null default '',
    modified   boolean not null default false,
    deleted    boolean not null default false,
    created_at timestamptz not null default now()
);
create index if not exists session_bets_session on public.session_bets(session_id);
alter table public.session_bets add column if not exists owner uuid;
update public.session_bets set owner = nullif(current_setting('app.base_owner', true), '')::uuid where owner is null;
alter table public.session_bets alter column owner set default auth.uid();

alter table public.trading_sessions enable row level security;
alter table public.trading_entries  enable row level security;
alter table public.match_sessions    enable row level security;
alter table public.session_bets      enable row level security;
drop policy if exists "trading_sessions_auth_all" on public.trading_sessions;
drop policy if exists "trading_entries_auth_all"  on public.trading_entries;
drop policy if exists "match_sessions_auth_all"   on public.match_sessions;
drop policy if exists "session_bets_auth_all"     on public.session_bets;
drop policy if exists "trading_sessions_own" on public.trading_sessions;
drop policy if exists "trading_entries_own"  on public.trading_entries;
drop policy if exists "match_sessions_own"   on public.match_sessions;
drop policy if exists "session_bets_own"     on public.session_bets;
create policy "trading_sessions_own" on public.trading_sessions for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "trading_entries_own"  on public.trading_entries  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "match_sessions_own"   on public.match_sessions   for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "session_bets_own"     on public.session_bets      for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
grant select, insert, update, delete on public.trading_sessions to authenticated;
grant select, insert, update, delete on public.trading_entries  to authenticated;
grant select, insert, update, delete on public.match_sessions   to authenticated;
grant select, insert, update, delete on public.session_bets      to authenticated;

-- ============================================================
--  Tenant profiles — white-label business name + paid mobile add-on flag
--  One row per user. Each user may READ ONLY their own row and CANNOT change
--  it (no write policy for `authenticated`, so RLS denies inserts/updates).
--  The owner manages these rows through the admin tool, which uses the
--  service_role key and therefore bypasses RLS.
-- ============================================================
create table if not exists public.profiles (
    owner          uuid primary key,
    business_name  text not null default '',
    mobile_enabled boolean not null default false,   -- legacy; superseded by mobile_until
    mobile_until   timestamptz,                        -- mobile active while now() < mobile_until (null/past = off)
    created_at     timestamptz not null default now()
);
-- add the subscription-expiry column on existing installs
alter table public.profiles add column if not exists mobile_until timestamptz;
-- anyone previously switched ON (boolean) keeps access with a far-future expiry
update public.profiles set mobile_until = timestamptz '2099-12-31 00:00:00+00'
  where mobile_enabled = true and mobile_until is null;

alter table public.profiles enable row level security;
drop policy if exists "profiles_read_own" on public.profiles;
create policy "profiles_read_own" on public.profiles for select to authenticated using (owner = auth.uid());
-- (intentionally no insert/update/delete policy for authenticated: users cannot
--  grant themselves mobile access or rename their own tenant.)
grant select on public.profiles to authenticated;

-- Seed the base owner's own profile (owner keeps mobile forever).
insert into public.profiles (owner, business_name, mobile_enabled, mobile_until)
select nullif(current_setting('app.base_owner', true), '')::uuid, 'thedeveloper', true, timestamptz '2099-12-31 00:00:00+00'
where nullif(current_setting('app.base_owner', true), '') is not null
  and not exists (select 1 from public.profiles where owner = nullif(current_setting('app.base_owner', true), '')::uuid);

-- ============================================================
--  Admins — who may use the online admin function (owner only).
--  Only the service_role (the admin Edge Function) reads this; no
--  policy for `authenticated`, so RLS blocks normal users entirely.
-- ============================================================
create table if not exists public.admins (
    uid        uuid primary key,
    created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
-- (no policies => authenticated users cannot read or write admins)
insert into public.admins (uid)
select nullif(current_setting('app.base_owner', true), '')::uuid
where nullif(current_setting('app.base_owner', true), '') is not null
on conflict (uid) do nothing;
