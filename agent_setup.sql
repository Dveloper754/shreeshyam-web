-- ============================================================================
-- Shree Shyam Book — agent logins (3rd login tier, below the bookmaker)
-- Run once in the Supabase SQL editor (after database.sql).
-- An agent is created by the bookmaker, belongs to ONE book, logs in on mobile
-- with a unique CODE + password, and sees ONLY his share (computed server-side).
-- ============================================================================

create table if not exists public.agent_logins (
  id          bigint generated always as identity primary key,
  owner       uuid not null,            -- the book (bookmaker) this agent belongs to
  agent_name  text not null,            -- EXACT name as in parties.config.agents[].name
  code        text not null unique,     -- login code (globally unique) = the username
  auth_uid    uuid,                     -- the agent's Supabase auth user id
  must_change_pw boolean not null default true,  -- force a password change on first login
  created_at  timestamptz not null default now()
);
create index if not exists agent_logins_owner on public.agent_logins(owner);
-- one login per agent name within a book
create unique index if not exists agent_logins_owner_name on public.agent_logins(owner, lower(agent_name));
create index if not exists agent_logins_uid on public.agent_logins(auth_uid);

alter table public.agent_logins enable row level security;

-- The bookmaker can SEE their own agents' logins (to list / manage).
drop policy if exists al_sel on public.agent_logins;
create policy al_sel on public.agent_logins
  for select using (owner = auth.uid() or auth_uid = auth.uid());

-- Creating/removing an agent (which also creates an auth user) is done by the
-- Edge Function with the service role only — never directly by a browser token.
grant select on public.agent_logins to authenticated;
grant all    on public.agent_logins to service_role;
