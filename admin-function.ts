// Shree Shyam — owner admin API (Supabase Edge Function).
// Holds the service-role key SERVER-SIDE (auto-injected by Supabase).
// Every request must carry the OWNER's own logged-in token; the function
// verifies the caller is listed in public.admins before doing anything.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DOMAIN = "@books.local";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function cleanName(s: unknown): string {
  return String(s ?? "").trim().toLowerCase().replace(/@.*/, "").replace(/\s+/g, "");
}
// days > 0  -> ISO timestamp that many days from now; else null (mobile off)
function untilFromDays(days: unknown): string | null {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(Date.now() + n * 86400000).toISOString();
}

// Data tables that belong to a client, in parent→child order (restore order).
const DATA_TABLES = ["parties", "closings", "entries", "trading_sessions", "match_sessions", "trading_entries", "session_bets"];

// deno-lint-ignore no-explicit-any
async function fetchAll(svc: any, table: string, owner: string): Promise<any[]> {
  const out: any[] = [];
  let from = 0; const size = 1000;
  // page through so clients with >1000 rows are fully exported
  // deno-lint-ignore no-constant-condition
  while (true) {
    const { data, error } = await svc.from(table).select("*").eq("owner", owner).range(from, from + size - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < size) break;
    from += size;
  }
  return out;
}

// Replace one client's current rows with the contents of a backup object.
// Returns null on success, or an error message string.
// deno-lint-ignore no-explicit-any
async function restoreInto(svc: any, owner: string, d: Record<string, any>): Promise<string | null> {
  if (!d || d._format !== "shreeshyam-backup-v1") return "Not a valid backup.";
  // wipe current rows (children first), then re-insert (parents first)
  for (const t of [...DATA_TABLES].reverse()) { const { error } = await svc.from(t).delete().eq("owner", owner); if (error) return `${t}: ${error.message}`; }
  await svc.from("settings").delete().eq("owner", owner);
  for (const t of DATA_TABLES) {
    const rows = (Array.isArray(d[t]) ? d[t] : []).map((r: Record<string, unknown>) => ({ ...r, owner }));
    if (rows.length) { const { error } = await svc.from(t).insert(rows); if (error) return `${t}: ${error.message}`; }
  }
  const srows = (Array.isArray(d.settings) ? d.settings : []).map((r: Record<string, unknown>) => ({ ...r, owner }));
  if (srows.length) { const { error } = await svc.from("settings").insert(srows); if (error) return `settings: ${error.message}`; }
  return null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // 1) identify the caller from their bearer token
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Not signed in" }, 401);
  const { data: who, error: whoErr } = await svc.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: "Session invalid — sign in again" }, 401);

  // 2) must be an admin (owner)
  const { data: adm } = await svc.from("admins").select("uid").eq("uid", who.user.id).maybeSingle();
  if (!adm) return json({ error: "You are not an admin." }, 403);

  // 3) do the requested action
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = String(body.action || "");

  try {
    if (action === "list") {
      const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const { data: profs } = await svc.from("profiles").select("owner, business_name, mobile_enabled, mobile_until, access_until");
      return json({ users: data?.users ?? [], profiles: profs ?? [] });
    }
    if (action === "create") {
      const uname = cleanName(body.username);
      const password = String(body.password || "");
      if (!uname || !password) return json({ error: "Username and password required" }, 400);
      const { data, error } = await svc.auth.admin.createUser({ email: uname + DOMAIN, password, email_confirm: true });
      if (error) return json({ error: error.message }, 400);
      const until = untilFromDays(body.mobile_days);
      // New client gets a subscription window (default 1 year) so they can use the app.
      const accDays = Number(body.access_days);
      const accessUntil = new Date(Date.now() + (Number.isFinite(accDays) && accDays > 0 ? accDays : 365) * 86400000).toISOString();
      await svc.from("profiles").upsert({ owner: data.user!.id, business_name: String(body.business_name || uname), mobile_enabled: !!until, mobile_until: until, access_until: accessUntil });
      return json({ ok: true });
    }
    if (action === "set_access") {
      // Grant / extend the subscription. days>0 extends from the later of now or current expiry.
      const id = String(body.id);
      const days = Number(body.days);
      if (!Number.isFinite(days) || days <= 0) return json({ error: "Enter a positive number of days." }, 400);
      const { data: prof } = await svc.from("profiles").select("access_until").eq("owner", id).maybeSingle();
      const cur = prof && prof.access_until ? Date.parse(prof.access_until) : 0;
      const base = cur > Date.now() ? cur : Date.now();
      const until = new Date(base + days * 86400000).toISOString();
      const { error } = await svc.from("profiles").upsert({ owner: id, access_until: until });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, access_until: until });
    }
    if (action === "revoke_access") {
      // Immediately end the subscription (data access stops at once).
      const id = String(body.id);
      const { error } = await svc.from("profiles").upsert({ owner: id, access_until: new Date(Date.now() - 1000).toISOString() });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "mobile_plan") {
      const until = untilFromDays(body.days);
      await svc.from("profiles").upsert({ owner: String(body.id), mobile_enabled: !!until, mobile_until: until });
      return json({ ok: true, mobile_until: until });
    }
    if (action === "set_username") {
      const uname = cleanName(body.username);
      if (!uname) return json({ error: "Username required" }, 400);
      const { error } = await svc.auth.admin.updateUserById(String(body.id), { email: uname + DOMAIN, email_confirm: true });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "rename") {
      await svc.from("profiles").upsert({ owner: String(body.id), business_name: String(body.business_name || "") });
      return json({ ok: true });
    }
    if (action === "password") {
      const password = String(body.password || "");
      if (!password) return json({ error: "Password required" }, 400);
      const { error } = await svc.auth.admin.updateUserById(String(body.id), { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "ban") {
      const { error } = await svc.auth.admin.updateUserById(String(body.id), { ban_duration: body.banned ? "none" : "876000h" });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "export") {
      // Build + return a JSON snapshot for download (does not touch the DB).
      const o = String(body.id);
      // deno-lint-ignore no-explicit-any
      const out: Record<string, any> = { _format: "shreeshyam-backup-v1", _owner: o, _exported_at: new Date().toISOString() };
      for (const t of DATA_TABLES) out[t] = await fetchAll(svc, t, o);
      out["settings"] = await fetchAll(svc, "settings", o);
      return json({ ok: true, data: out });
    }
    if (action === "backup_now") {
      // Save a dated snapshot for ONE client into the database (keeps 10 days).
      const o = String(body.id);
      const { data, error } = await svc.rpc("take_client_backup", { o });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, backup_id: data });
    }
    if (action === "backup_all") {
      // Save a dated snapshot for EVERY client right now.
      const { data, error } = await svc.rpc("take_all_backups");
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, count: data });
    }
    if (action === "list_backups") {
      // Dated restore points saved in the database for one client.
      const o = String(body.id);
      const { data, error } = await svc.from("client_backups")
        .select("id, taken_at, day, label").eq("owner", o).order("taken_at", { ascending: false });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, backups: data ?? [] });
    }
    if (action === "restore_from") {
      // Restore ONE client from a dated backup already stored in the database.
      const o = String(body.id);
      const backupId = body.backup_id;
      const { data: row, error: selErr } = await svc.from("client_backups")
        .select("data").eq("owner", o).eq("id", backupId).maybeSingle();
      if (selErr) return json({ error: selErr.message }, 400);
      if (!row) return json({ error: "That backup was not found." }, 404);
      const r = await restoreInto(svc, o, row.data as Record<string, unknown>);
      if (r) return json({ error: r }, 400);
      return json({ ok: true });
    }
    if (action === "restore") {
      // Restore ONE client from an uploaded JSON file (fallback path).
      const o = String(body.id);
      const r = await restoreInto(svc, o, (body.data ?? {}) as Record<string, unknown>);
      if (r) return json({ error: r }, 400);
      return json({ ok: true });
    }
    if (action === "delete") {
      const target = String(body.id);
      if (target === who.user.id) return json({ error: "You can't delete your own account." }, 400);
      const { data: tgtAdmin } = await svc.from("admins").select("uid").eq("uid", target).maybeSingle();
      if (tgtAdmin) return json({ error: "That account is an admin — remove it from the admins table first." }, 400);
      const { error } = await svc.auth.admin.deleteUser(target);
      if (error) return json({ error: error.message }, 400);
      await svc.from("profiles").delete().eq("owner", target);
      return json({ ok: true });
    }
    // ---- Desktop licensing ----
    if (action === "lic_generate") {
      const type = String(body.type || "").toLowerCase();
      if (type !== "pc" && type !== "pendrive") return json({ error: "Choose device type (pc or pendrive)." }, 400);
      const client_user = String(body.client_user || "").trim().toLowerCase().replace(/@.*/, "");
      if (!client_user) return json({ error: "Enter the client's username — the app will be locked to that login." }, 400);
      const note = String(body.note || "").trim();
      // Unique, readable code: SSB-XXXX-XXXX (no confusing chars).
      const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const grp = () => Array.from({ length: 4 }, () => ALPH[Math.floor(Math.random() * ALPH.length)]).join("");
      let code = "";
      for (let i = 0; i < 6; i++) {
        code = `SSB-${grp()}-${grp()}`;
        const { data: ex } = await svc.from("licenses").select("code").eq("code", code).maybeSingle();
        if (!ex) break;
      }
      const { error } = await svc.from("licenses").insert({ code, type, client_user, note, status: "active" });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, code });
    }
    if (action === "lic_list") {
      const { data, error } = await svc.from("licenses")
        .select("code, type, client_user, bound_fingerprint, status, issued_at, activated_at, expires_at, note")
        .order("issued_at", { ascending: false }).limit(500);
      if (error) return json({ error: error.message }, 400);
      return json({ licenses: data ?? [] });
    }
    if (action === "lic_revoke") {
      const code = String(body.code || "").trim().toUpperCase();
      const { error } = await svc.from("licenses").update({ status: "revoked" }).eq("code", code);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "lic_renew") {
      // Extend validity by one year (from now if already expired) and re-activate the code.
      const code = String(body.code || "").trim().toUpperCase();
      const { data: row } = await svc.from("licenses").select("expires_at").eq("code", code).maybeSingle();
      if (!row) return json({ error: "Code not found." }, 404);
      const base = row.expires_at && Date.parse(row.expires_at) > Date.now() ? Date.parse(row.expires_at) : Date.now();
      const next = new Date(base + 365 * 86400000).toISOString();
      const { error } = await svc.from("licenses").update({ expires_at: next, status: "active" }).eq("code", code);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, expires_at: next });
    }
    if (action === "lic_rebind") {
      // Allow moving a license to a new device (e.g. lost pendrive): clear the binding.
      const code = String(body.code || "").trim().toUpperCase();
      const { error } = await svc.from("licenses").update({ bound_fingerprint: null }).eq("code", code);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
