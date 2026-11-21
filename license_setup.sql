-- ============================================================
--  Licensing for the desktop app (Shree Shyam Book).
--  Run this once in Supabase → SQL editor.
--  The admin panel generates codes; the exe activates against them.
--  All access is through Edge Functions using the service role, so
--  the table is locked to service_role only (no direct client access).
-- ============================================================

create table if not exists public.licenses (
  code              text primary key,                 -- e.g. SSB-7FQ2-9K4D
  type              text not null check (type in ('pc','pendrive')),
  client_user       text,                             -- which login this copy is for (info)
  bound_fingerprint text,                             -- set on first activation; null until then
  status            text not null default 'active',   -- 'active' | 'revoked'
  issued_at         timestamptz not null default now(),
  activated_at      timestamptz,                      -- first successful activation
  expires_at        timestamptz,                      -- validity end (admin-controlled; 1 yr on activation)
  signed_license    jsonb,                            -- last signed license issued (for audit)
  note              text
);

create index if not exists licenses_client_idx on public.licenses (client_user);
create index if not exists licenses_status_idx on public.licenses (status);

alter table public.licenses enable row level security;
-- No policies for 'authenticated' → ordinary users cannot read/write.
-- Edge Functions use the service role, which bypasses RLS.
grant all on public.licenses to service_role;
revoke all on public.licenses from anon, authenticated;
