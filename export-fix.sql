-- ============================================================================
-- Make the app's local backup+restore COMPLETE: include the match/session tables
-- (trading_sessions, match_sessions, trading_entries, session_bets) the old
-- functions left out. Both are security invoker, so RLS keeps each caller to
-- their own rows. After this runs, every logout backup file contains saudas,
-- and restoring such a file brings them back.
-- ============================================================================

create or replace function public.export_data() returns jsonb
language sql security invoker as $$
  select jsonb_build_object(
    'exported_at',      now(),
    'parties',          (select coalesce(jsonb_agg(to_jsonb(p)),  '[]'::jsonb) from public.parties p),
    'closings',         (select coalesce(jsonb_agg(to_jsonb(c)),  '[]'::jsonb) from public.closings c),
    'entries',          (select coalesce(jsonb_agg(to_jsonb(e)),  '[]'::jsonb) from public.entries e),
    'trading_sessions', (select coalesce(jsonb_agg(to_jsonb(ts)), '[]'::jsonb) from public.trading_sessions ts),
    'match_sessions',   (select coalesce(jsonb_agg(to_jsonb(ms)), '[]'::jsonb) from public.match_sessions ms),
    'trading_entries',  (select coalesce(jsonb_agg(to_jsonb(te)), '[]'::jsonb) from public.trading_entries te),
    'session_bets',     (select coalesce(jsonb_agg(to_jsonb(sb)), '[]'::jsonb) from public.session_bets sb),
    'settings',         (select to_jsonb(s) from public.settings s where s.owner = auth.uid())
  );
$$;

create or replace function public.restore_data(p_data jsonb) returns void
language plpgsql security invoker as $$
begin
    -- wipe children first
    delete from public.session_bets     where true;
    delete from public.trading_entries  where true;
    delete from public.match_sessions   where true;
    delete from public.trading_sessions where true;
    delete from public.entries  where true;
    delete from public.closings where true;
    delete from public.parties  where true;
    -- re-insert parents first
    insert into public.parties          select * from jsonb_populate_recordset(null::public.parties,          coalesce(p_data->'parties','[]'::jsonb));
    insert into public.closings         select * from jsonb_populate_recordset(null::public.closings,         coalesce(p_data->'closings','[]'::jsonb));
    insert into public.entries          select * from jsonb_populate_recordset(null::public.entries,          coalesce(p_data->'entries','[]'::jsonb));
    insert into public.trading_sessions select * from jsonb_populate_recordset(null::public.trading_sessions, coalesce(p_data->'trading_sessions','[]'::jsonb));
    insert into public.match_sessions   select * from jsonb_populate_recordset(null::public.match_sessions,   coalesce(p_data->'match_sessions','[]'::jsonb));
    insert into public.trading_entries  select * from jsonb_populate_recordset(null::public.trading_entries,  coalesce(p_data->'trading_entries','[]'::jsonb));
    insert into public.session_bets     select * from jsonb_populate_recordset(null::public.session_bets,     coalesce(p_data->'session_bets','[]'::jsonb));
    if p_data ? 'settings' and jsonb_typeof(p_data->'settings') = 'object' then
        update public.settings set
            opening_capital = coalesce((p_data->'settings'->>'opening_capital')::numeric, opening_capital),
            auto_backup     = coalesce((p_data->'settings'->>'auto_backup')::boolean, auto_backup)
        where owner = auth.uid();
    end if;
end; $$;
