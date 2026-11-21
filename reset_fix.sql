-- ============================================================
-- Reset + agents/partners storage fix.
-- Paste this whole file into the Supabase SQL editor and Run.
-- (Deleting from trading_sessions cascades to match_sessions,
--  trading_entries and session_bets, so one delete clears all
--  the matches & saudas.)  Safe to run multiple times.
-- ============================================================

-- 0) Storage for the agents master list and the global partners list.
--    Required for Create -> Agents / Create -> Partners to save at all.
alter table public.settings add column if not exists agents   jsonb not null default '[]'::jsonb;
alter table public.settings add column if not exists partners jsonb not null default '[]'::jsonb;

-- 1) "Clear Data / Keep Cl Balance"
--    Clears all ledger entries AND all matches & saudas, but keeps
--    every party and rolls their closing balance forward into
--    opening_balance (a party with a zero balance still stays).
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

-- 2) "Clear All Balance"
--    Clears ONLY the match & session saudas. Keeps every client
--    ledger entry, every party, and all balances.
create or replace function public.entries_reset() returns void language plpgsql security invoker as $$
begin
    delete from public.trading_sessions where true;   -- cascades to match_sessions, trading_entries, session_bets
end; $$;

-- 3) "Clear Programe"
--    Erases everything (ledger, parties, matches & saudas).
create or replace function public.full_reset() returns void language plpgsql security invoker as $$
begin
    delete from public.entries  where true;
    delete from public.closings where true;
    delete from public.parties where true;
    delete from public.trading_sessions where true;   -- cascades to match_sessions, trading_entries, session_bets
    update public.settings set opening_capital = 0, agents = '[]'::jsonb, partners = '[]'::jsonb where owner = auth.uid();
end; $$;
